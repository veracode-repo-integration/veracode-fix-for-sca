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
    const binaryNames = isWindows ? ['veracode.exe'] : ['veracode', 'veracode'];
    const veracodeBinary = binaryNames
      .map((binaryName) => path.join(`${process.env.CLI_PATH}`, binaryName))
      .find((binaryPath) => fs.existsSync(binaryPath));
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
    const cliConfigPath = path.join(os.homedir(), '.veracode', 'veracode.yml');
    core.info(`Checking repository Veracode configuration: ${repositoryConfigPath}`);
    core.info(`Repository Veracode configuration present: ${fs.existsSync(repositoryConfigPath)}`);
    if (fs.existsSync(repositoryConfigPath)) {
      const cliConfigDir = path.dirname(cliConfigPath);
      fs.mkdirSync(cliConfigDir, { recursive: true });
      fs.copyFileSync(repositoryConfigPath, cliConfigPath);
      core.info(`CLI Veracode configuration present: ${fs.existsSync(cliConfigPath)}`);
    } else {
      core.info(`No Veracode configuration found at ${repositoryConfigPath}, writing default config`);
      const cliConfigDir = path.dirname(cliConfigPath);
      fs.mkdirSync(cliConfigDir, { recursive: true });
      const defaultConfig = `veracode_static_scan:
  push:
    trigger: true
    branches_to_run:
      - '*'
    branches_to_exclude:
  pull_request:
    trigger: true
    action:
      - opened
      - synchronize
    target_branch:
      - default_branch
  analysis_on_platform: true
  break_build_policy_findings: true
  break_build_invalid_policy: true
  break_build_on_error: false
  error_message: "Veracode static scan faced a problem. Please contact your Veracode administrator for more information."
  policy: 'Veracode Recommended Medium + SCA'
  create_code_scanning_alert: false
  create_issue: false
  issues:
    trigger: true
    commands:
      - "Veracode Static Scan"
  fix_for_sast:
    pull_request:
      trigger: true

veracode_sca_scan:
  push:
    trigger: true
    branches_to_run:
      - '*'
    branches_to_exclude:
  pull_request:
    trigger: true
    action:
      - opened
      - synchronize
    target_branch:
      - default_branch
  fix_for_sca:
    pull_request:
      trigger: true
  break_build_on_error: true
  break_build_policy_findings: true
  error_message: "Veracode SCA scan faced a problem. Please contact your Veracode administrator for more information."
  issues:
    trigger: false
    commands:
      - "Veracode SCA Scan"

veracode_iac_secrets_scan:
  push:
    trigger: true
    branches_to_run:
      - '*'
    branches_to_exclude:
  pull_request:
    trigger: true
    action:
      - opened
      - synchronize
    target_branch:
      - default_branch
  break_build_policy_findings: true
  break_build_on_error: true
  error_message: "Veracode IAC secrets scan faced a problem. Please contact your Veracode administrator for more information."
  issues:
    trigger: false
    commands:
      - "Veracode IAC Scan"
`;
      fs.writeFileSync(cliConfigPath, defaultConfig);
      core.info(`Default Veracode configuration written to ${cliConfigPath}`);
    }

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
