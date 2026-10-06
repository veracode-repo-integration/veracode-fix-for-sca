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
    // Set GitHub output with the batch fix response
    const sastResponsePath = path.join(sourceCodeDir, 'sast_fix_response.json');
    if (fs.existsSync(sastResponsePath)) {
      const sastResponseContent = fs.readFileSync(sastResponsePath, 'utf8');
      core.info(`SAST Fix Response JSON file: ${sastResponseContent}`);
    }
    await exec.exec('bash', ['-c', `echo "result=$(cat sast_fix_response.json)" >> $GITHUB_OUTPUT`], {
      cwd: sourceCodeDir
    });

    // Parse the SAST fix response and enrich flaws with severity and fix_id from results.json
    let batchFixResponse = null;
    try {
      if (fs.existsSync(sastResponsePath)) {
        const sastResponseJson = JSON.parse(fs.readFileSync(sastResponsePath, 'utf8'));
        batchFixResponse = sastResponseJson.patch || sastResponseJson;

        // Build a map of issue_id → { fix_id, severity } from results.json
        const findingsMap = {};
        try {
          const resultsContent = fs.readFileSync(resultsFilePath, 'utf8');
          const resultsJson = JSON.parse(resultsContent);
          if (resultsJson.findings && Array.isArray(resultsJson.findings)) {
            resultsJson.findings.forEach((finding) => {
              const issueId = finding.issue_id;
              const fixId = finding.fix_id || 'N/A';
              const severityValue = finding.severity || 3;
              let severityText = 'Medium';
              if (severityValue === 5) severityText = 'Very High';
              else if (severityValue === 4) severityText = 'High';
              else if (severityValue === 3) severityText = 'Medium';
              else if (severityValue === 2) severityText = 'Low';
              else if (severityValue === 1) severityText = 'Informational';
              findingsMap[issueId] = { fix_id: fixId, severity: severityText };
            });
          } else {
            core.warning('No findings array in results.json');
          }
        } catch (mapError) {
          core.warning(`Unable to build findings map: ${mapError.message}`);
        }

        // Enrich flaws with severity and fix_id matched by issueId
        if (batchFixResponse && batchFixResponse.flaws && Array.isArray(batchFixResponse.flaws)) {
          batchFixResponse.flaws.forEach((flaw) => {
            const match = findingsMap[flaw.issueId];
            flaw.severity = match ? match.severity : 'Medium';
            flaw.fix_id = match ? match.fix_id : 'N/A';
          });
        }

        core.info(`Batch fix response: ${JSON.stringify(batchFixResponse, null, 2)}`);

        const responseDir = path.join(workspaceDir, 'veracode_artifact_directory');
        fs.mkdirSync(responseDir, { recursive: true });
        const responseFilePath = path.join(responseDir, 'sast-fix-batch-response.json');
        fs.writeFileSync(responseFilePath, JSON.stringify(batchFixResponse, null, 2));
        core.info(`CLI batch fix response saved to ${responseFilePath}`);
      } else {
        core.warning(`SAST fix response file not found at ${sastResponsePath}`);
      }
    } catch (parseError) {
      core.warning(`Failed to parse SAST fix response: ${parseError.message}`);
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
      return { hasChanges: false, batchFixResponse };
    }

    core.info('----- Git diff -----');
    try {
      await exec.exec('git', ['--no-pager', 'diff'], {
        cwd: sourceCodeDir
      });
    } catch (error) {
      core.warning(`Failed to show git diff: ${error.message}`);
    }

    return { hasChanges: true, batchFixResponse };
  } catch (error) {
    throw new Error(`Failed to run Fix for SAST: ${error.message}`);
  }
}

module.exports = runFixSast;
