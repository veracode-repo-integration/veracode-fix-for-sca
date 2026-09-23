const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('@actions/core');
const exec = require('@actions/exec');

async function runFixSast(workspaceDir, actionPath, fixScaParams, sourceCodeDir) {
  try {
    // Pass the downloaded SAST results from the GitHub workspace to the CLI.
    const resultsFilePath = path.join(workspaceDir, 'veracode_artifact_directory', 'results.json');
    if (fs.existsSync(resultsFilePath)) {
      const resultsContent = fs.readFileSync(resultsFilePath, 'utf8');
      const resultsJson = JSON.parse(resultsContent);
      core.info(`SAST results.json loaded ${JSON.stringify(resultsJson, null, 2)}`);
    } else {
      core.warn(`Results file not found at: ${resultsFilePath}`);
    }

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
    const allStdLines = [];
    await exec.exec(veracodeBinary, args, {
      env: { ...process.env },
      cwd: sourceCodeDir,
      listeners: {
        stdout: (data) => core.debug(`CLI stdout chunk: ${data.toString()}`),
        stderr: (data) => core.debug(`CLI stderr chunk: ${data.toString()}`),
        stdline: (line) => {
          core.info(`CLI response: ${line}`);
          allStdLines.push(line);
        },
        errline: (line) => core.warning(`CLI error: ${line}`),
        debug: (message) => core.debug(`CLI debug: ${message}`)
      }
    });

    // Extract the JSON batch fix response from CLI stdout.
    // The CLI prints structured log lines followed by a JSON object block.
    let batchFixResponse = null;
    try {
      const fullOutput = allStdLines.join('\n');
      // Find the first line that is exactly '{' — start of the JSON block
      const jsonStart = fullOutput.search(/(^|\n)\{/);
      if (jsonStart !== -1) {
        const jsonStr = fullOutput.substring(fullOutput.indexOf('{', jsonStart));
        // Walk character by character to find the balanced closing brace
        let depth = 0;
        let jsonEnd = -1;
        for (let i = 0; i < jsonStr.length; i++) {
          if (jsonStr[i] === '{') depth++;
          else if (jsonStr[i] === '}') {
            depth--;
            if (depth === 0) { jsonEnd = i + 1; break; }
          }
        }
        if (jsonEnd > 0) {
          const parsed = JSON.parse(jsonStr.substring(0, jsonEnd));
          // CLI wraps the batch response in { fixSessionId, patch }
          batchFixResponse = parsed.patch || parsed;

          // Build a map of issue_id to finding details from results.json
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

                findingsMap[issueId] = { fix_id: fixId, severity: severityText, cwe_id: finding.cwe_id };
              });
            } else {
              core.warn(`No findings array in results.json`);
            }
          } catch (mapError) {
            core.warn(`Unable to build findings map: ${mapError.message}`);
          }

          // Enrich batch response flaws with severity and fix_id (using dummy data for now)
          if (batchFixResponse && batchFixResponse.flaws && Array.isArray(batchFixResponse.flaws)) {
            batchFixResponse.flaws.forEach((flaw) => {
              // Use dummy values for now since we're testing with dummy data
              flaw.severity = flaw.severity || 'High';
              flaw.fix_id = flaw.fix_id || `SAST-${Math.floor(Math.random() * 10000)}`;
            });
          }

          core.info(`Batch fix response: ${JSON.stringify(batchFixResponse, null, 2)}`);

          const responseDir = path.join(workspaceDir, 'veracode_artifact_directory');
          fs.mkdirSync(responseDir, { recursive: true });
          const responseFilePath = path.join(responseDir, 'sast-fix-batch-response.json');
          fs.writeFileSync(responseFilePath, JSON.stringify(batchFixResponse, null, 2));
          core.info(`CLI batch fix response saved to ${responseFilePath}`);
        }
      }
      if (!batchFixResponse) {
        core.warning('Could not find JSON block in CLI stdout. Batch fix response will be unavailable.');
      }
    } catch (parseError) {
      core.warning(`Failed to parse CLI batch fix response: ${parseError.message}`);
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
