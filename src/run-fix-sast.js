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
    await exec.exec(veracodeBinary, args, {
      env: { ...process.env },
      cwd: sourceCodeDir,
      listeners: {
        stdout: (data) => core.debug(`CLI stdout chunk: ${data.toString()}`),
        stderr: (data) => core.debug(`CLI stderr chunk: ${data.toString()}`),
        stdline: (line) => core.info(`CLI response: ${line}`),
        errline: (line) => core.warning(`CLI error: ${line}`),
        debug: (message) => core.debug(`CLI debug: ${message}`)
      }
    });

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
      return { hasChanges: false };
    }

    core.info('----- Git diff -----');
    try {
      await exec.exec('git', ['--no-pager', 'diff'], {
        cwd: sourceCodeDir
      });
    } catch (error) {
      core.warning(`Failed to show git diff: ${error.message}`);
    }

    return { hasChanges: true };
  } catch (error) {
    throw new Error(`Failed to run Fix for SAST: ${error.message}`);
  }
}

module.exports = runFixSast;
