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
      
      core.info('========== SAST Results with Fix IDs ==========');
      if (resultsJson.findings && Array.isArray(resultsJson.findings)) {
        core.info(`Total findings: ${resultsJson.findings.length}`);
        resultsJson.findings.forEach((finding, index) => {
          const fileName = finding.files?.source_file?.file || 'Unknown';
          const fixId = finding.fix_id || 'N/A';
          core.info(`[${index + 1}] Fix ID: ${fixId} | File: ${fileName}`);
        });
      }
      core.info('============================================');
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
    
    const repositoryConfigPath = path.join(workspaceDir, 'veracode.yml');
    core.info(`Checking repository Veracode configuration: ${repositoryConfigPath}`);
    core.info(`Repository Veracode configuration present: ${fs.existsSync(repositoryConfigPath)}`);

    const credentialsPath = path.join(os.homedir(), '.veracode', 'credentials');
    if (!fs.existsSync(credentialsPath)) {
      const apiId = process.env.VERACODE_API_KEY_ID;
      const apiKey = process.env.VERACODE_API_KEY_SECRET;
      if (apiId && apiKey) {
        const credentialsDir = path.dirname(credentialsPath);
        fs.mkdirSync(credentialsDir, { recursive: true });
        const credentialsContent = `[default]\nveracode_api_key_id = ${apiId}\nveracode_api_key_secret = ${apiKey}\n`;
        fs.writeFileSync(credentialsPath, credentialsContent, { mode: 0o600 });
        core.info(`Generated Veracode credentials file at ${credentialsPath}`);
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

    // if (fixScaParams && fixScaParams.trim() && fixScaParams !== 'SAST-*') {
    //   core.info(`Fix SAST params: ${fixScaParams}`);
    //   args.push('-i', fixScaParams);
    // }

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

          // Build a map of cwe_id:path:severity to {fix_id} from results.json
          // (Line numbers not available in results.json, so use CWE + path + severity)
          const findingsMap = {};
          try {
            const resultsContent = fs.readFileSync(resultsFilePath, 'utf8');
            const resultsJson = JSON.parse(resultsContent);

            if (resultsJson.findings && Array.isArray(resultsJson.findings)) {
              core.info(`Found ${resultsJson.findings.length} findings in results.json`);
              resultsJson.findings.forEach((finding, idx) => {
                const filePath = finding.files?.source_file?.file || finding.path || '';
                const cweId = finding.cwe_id || 'unknown';
                const fixId = finding.fix_id || 'N/A';
                const severityValue = finding.severity || 3;
                let severityText = 'Medium';
                if (severityValue === 5) severityText = 'Very High';
                else if (severityValue === 4) severityText = 'High';
                else if (severityValue === 3) severityText = 'Medium';
                else if (severityValue === 2) severityText = 'Low';
                else if (severityValue === 1) severityText = 'Informational';

                const key = `${cweId}:${filePath}:${severityValue}`;
                findingsMap[key] = { fix_id: fixId, severity: severityText };
              });
              core.info(`Built findingsMap with ${Object.keys(findingsMap).length} unique findings`);
            } else {
              core.warn(`No findings array in results.json`);
            }
          } catch (mapError) {
            core.warn(`Unable to build findings map: ${mapError.message}`);
          }

          // Append fix_id and severity to each flaw by matching cwe_id:path:severity
          if (batchFixResponse.flaws && Array.isArray(batchFixResponse.flaws)) {
            batchFixResponse.flaws.forEach(flaw => {
              const flawKey = `${flaw.cweId}:${flaw.path}:${flaw.severity}`;
              const match = findingsMap[flawKey];
              if (match) {
                flaw.fix_id = match.fix_id;
                flaw.severity = findingsMap[flawKey].severity;
                core.info(`✓ issueId ${flaw.issueId}: fix_id=${flaw.fix_id}, severity=${flaw.severity}`);
              } else {
                core.debug(`No mapping for ${flawKey} (issueId: ${flaw.issueId})`);
              }
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
