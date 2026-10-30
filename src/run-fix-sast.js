const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('@actions/core');
const exec = require('@actions/exec');

async function runFixSast(workspaceDir, actionPath, fixScaParams, sourceCodeDir) {
  try {
    // Pass the downloaded SAST results from the GitHub workspace to the CLI.
    const resultsFilePath = path.join(workspaceDir, 'veracode_artifact_directory', 'results.json');

    // Set up environment for veracode CLI
    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'veracode.exe' : 'veracode';
    const veracodeBinary = path.join(`${process.env.CLI_PATH}`, binaryName);
    if (!veracodeBinary) {
      throw new Error(`Unable to locate Veracode CLI in ${process.env.CLI_PATH}`);
    }

    // Build command arguments
    const args = [
      'fix',
      'static',
      sourceCodeDir,
      '--results',
      path.join(
        workspaceDir,
        'veracode_artifact_directory',
        'results.json'
      ),
      // '--async',
      // '--decouple',
      // 'true',
    ];

    const credentialsPath = path.join(os.homedir(), '.veracode', 'credentials');
    if (!fs.existsSync(credentialsPath)) {
      const apiId = process.env.VERACODE_API_KEY_ID;
      const apiKey = process.env.VERACODE_API_KEY_SECRET;
      core.info(`API KEY ${apiId}`);
      core.info(`API SECRET ${apiKey}`);
      if (apiId && apiKey) {
        const credentialsDir = path.dirname(credentialsPath);
        fs.mkdirSync(credentialsDir, { recursive: true });
        const credentialsContent = `[default]\nveracode_api_key_id = ${apiId}\nveracode_api_key_secret = ${apiKey}\n`;
        fs.writeFileSync(credentialsPath, credentialsContent, { mode: 0o600 });
      } else {
        core.warning(`VERACODE_API_KEY_ID or VERACODE_API_KEY_SECRET not set in environment`);
      }
    }

    core.info('--------- Running inside fix for sast ---------');
    // Conditionally add --remote flag (default: false)
    const fixRemote = core.getInput('fix-remote');
    if (fixRemote?.toLowerCase() === 'true') {
      core.info(`remote argument appended`)
      args.push('--remote');
    
    }

    // @actions/exec forwards CLI stdout and stderr to the GitHub Actions log.
    core.info(`Running: ${veracodeBinary} ${args.join(' ')}`);
    await exec.exec(veracodeBinary, args, {
      env: { ...process.env },
      cwd: sourceCodeDir,
      // listeners: {
      //   stdout: (data) => core.debug(`CLI stdout chunk: ${data.toString()}`),
      //   stderr: (data) => core.debug(`CLI stderr chunk: ${data.toString()}`),
      //   stdline: (line) => {
      //     core.info(`CLI response: ${line}`);
      //     allStdLines.push(line);
      //   },
      //   errline: (line) => core.warning(`CLI error: ${line}`),
      //   debug: (message) => core.debug(`CLI debug: ${message}`)
      // }
    });

    core.info(`CLI execution completed. Checking for changes in source code directory: ${sourceCodeDir}`);

    // Enrich the CLI-generated sast-fix-report.md with per-CWE severity, looked up from
    // the SAST results.json (the report itself has no severity information).
    const reportPath = path.join(sourceCodeDir, 'sast-fix-report.md');
    let reportContent = null;
    if (fs.existsSync(reportPath)) {
      try {
        const rawReport = fs.readFileSync(reportPath, 'utf8');
        const resultsJson = JSON.parse(fs.readFileSync(resultsFilePath, 'utf8'));
        const cweSeverityMap = buildCweSeverityMap(resultsJson);
        reportContent = appendSeverityToReport(rawReport, cweSeverityMap);
        reportContent = appendRescanNote(reportContent);
        fs.writeFileSync(reportPath, reportContent, 'utf8');
        core.info('Enriched sast-fix-report.md with CWE severity information');
      } catch (reportError) {
        core.warning(`Failed to enrich sast-fix-report.md with severity info: ${reportError.message}`);
        reportContent = fs.readFileSync(reportPath, 'utf8');
      }
    } else {
      core.warning(`sast-fix-report.md not found at ${reportPath}`);
    }

    let hasChanges = false;
    let gitDiffOutput = '';

    try {
      await exec.exec('git', ['diff', '--name-only', 'HEAD'], {
        cwd: sourceCodeDir,
        listeners: {
          stdout: (data) => {
            gitDiffOutput += data.toString();
          }
        }
      });

      hasChanges = gitDiffOutput.trim().length > 0;
    } catch (error) {
      core.warning(`Failed to check git diff: ${error.message}`);
    }


    if (!hasChanges) {
      core.info('No changes to existing files detected. Skipping branch creation and PR.');
      return { hasChanges: false, reportContent };
    }

    core.info('----- Git diff -----');
    try {
      await exec.exec('git', ['--no-pager', 'diff'], {
        cwd: sourceCodeDir
      });
    } catch (error) {
      core.warning(`Failed to show git diff: ${error.message}`);
    }

    return { hasChanges: true, reportContent };
  } catch (error) {
    throw new Error(`Failed to run Fix for SAST: ${error.message}`);
  }
}

const SEVERITY_LABELS = { 5: '🔴', 4: '🟠', 3: '🟡', 2: '🟢', 1: '🔵' };

/**
 * Build a map of cwe_id -> { value, label } from results.json findings, keeping the
 * highest severity seen for each CWE (a CWE can have multiple findings of differing severity).
 */
function buildCweSeverityMap(resultsJson) {
  const map = {};
  if (resultsJson?.findings && Array.isArray(resultsJson.findings)) {
    resultsJson.findings.forEach((finding) => {
      const cweId = String(finding.cwe_id);
      const severityValue = finding.severity ?? 3;
      if (!map[cweId] || severityValue > map[cweId].value) {
        map[cweId] = { value: severityValue, label: SEVERITY_LABELS[severityValue] || 'Medium' };
      }
    });
  }
  return map;
}

/**
 * Appends "[<severity>]" after every "CWE-<id> (<count>)" occurrence in the report text.
 */
function appendSeverityToReport(reportContent, cweSeverityMap) {
  return reportContent.replace(/CWE-(\d+)\s*\((\d+)\)/g, (match, cweId, count) => {
    const severity = cweSeverityMap[cweId];
    return severity ? `CWE-${cweId} (${count}) [${severity.label}]` : match;
  });
}

/**
 * Appends a GitHub Markdown alert reminding reviewers to rescan to confirm CWE fixes.
 */
function appendRescanNote(reportContent) {
  return `${reportContent.trimEnd()}\n\n> [!NOTE]\n> Rescan is recommended to confirm CWE fixes.\n`;
}

module.exports = runFixSast;
