const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('@actions/core');
const exec = require('@actions/exec');

// Printed by the CLI only in fire-and-forget mode
const FNF_MARKERS = [
  'Fix for SCA job(s) submitted to backend',
  'Building GitHubContext for FNF callback',
];

async function runFixSca(workspaceDir, actionPath, fixScaParams, enableFnf = false, correlationId = null) {
  try {
    const projectRootDir = '';
    const sourceCodeDir = path.join(workspaceDir, 'source-code', projectRootDir);

    core.info(`Project path: ${sourceCodeDir}`);

    // Set up environment for veracode CLI
    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'veracode.exe' : 'veracode';
    const veracodeBinary = path.join(`${process.env.CLI_PATH}`, binaryName);

    core.info(`Veracode binary: ${veracodeBinary}`);
    core.info(`Binary exists: ${fs.existsSync(veracodeBinary)}`);

    // Find SCA results file
    const artifactDir = path.join(workspaceDir, 'veracode_artifact_directory');
    const possiblePaths = [
      path.join(artifactDir, 'Veracode Agent Based SCA Results', 'scaResults.json'),
      path.join(artifactDir, 'scaResults.json'),
    ];

    let scaResultsPath = null;
    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        scaResultsPath = possiblePath;
        core.info(`Found SCA results at: ${scaResultsPath}`);
        break;
      }
    }

    if (!scaResultsPath) {
      throw new Error(`Could not find SCA results file in ${artifactDir}`);
    }

    // Build command arguments
    const args = [
      'fix',
      'sca',
      sourceCodeDir,
      '--results',
      scaResultsPath,
    ];

    // Conditionally add --remote flag (default: false)
    const fixRemote = core.getInput('fix-remote');
    if (fixRemote?.toLowerCase() === 'true') {
      core.info(`remote argument appended`)
      args.push('--remote');
    }
    if (fixScaParams && fixScaParams.trim() && fixScaParams !== 'SCA-*') {
      core.info(`Fix SCA params: ${fixScaParams}`);
      args.push('-i', fixScaParams);
    }

    // Run veracode fix sca command
    core.info(`Running: ${veracodeBinary} ${args.join(' ')}`);

    let cliOutput = '';
    let cliExitCode = 0;

    // Pass GitHub context via environment variables for fire-and-forget callback
    const env = { ...process.env };
    if (enableFnf) {
      env.FNF_FEATURE_FLAG = 'true';
      env.CORRELATION_ID = correlationId;
    }

    try {
      cliExitCode = await exec.exec(veracodeBinary, args, {
        env: env,
        listeners: {
          stdout: (data) => {
            cliOutput += data.toString();
          },
          stderr: (data) => {
            cliOutput += data.toString();
          }
        },
        ignoreReturnCode: true,
      });
    } catch (error) {
      core.error(`[CLI_ERROR] Failed to execute veracode CLI: ${error.message}`);
      throw error;
    }

    // Check for CLI errors - if exit code is non-zero, submission likely failed
    if (cliExitCode !== 0) {
      // Extract error details from CLI output
      const errorLines = cliOutput
        .split('\n')
        .filter((line) => line.includes('ERR') || line.includes('Error'))
        .slice(-5)
        .join('\n');

      core.error(
        `[CLI_SUBMISSION_FAILED] CLI exited with code ${cliExitCode}`
      );
      core.error(`[CLI_SUBMISSION_FAILED] Recent errors:\n${errorLines}`);

      // Check for specific HTTP error codes in output
      const has500Error = cliOutput.includes('500 Internal Server Error');
      const has400Error = cliOutput.includes('400') || cliOutput.includes('Bad Request');
      const has401Error = cliOutput.includes('401') || cliOutput.includes('Unauthorized');
      const has403Error = cliOutput.includes('403') || cliOutput.includes('Forbidden');

      if (has500Error) {
        core.error(
          '[BACKEND_ERROR] Backend service returned 500 Internal Server Error'
        );
      } else if (has400Error) {
        core.error('[BACKEND_ERROR] Backend service returned 400 Bad Request');
      } else if (has401Error) {
        core.error('[BACKEND_ERROR] Backend service returned 401 Unauthorized');
      } else if (has403Error) {
        core.error('[BACKEND_ERROR] Backend service returned 403 Forbidden');
      }

      core.setOutput('run-next-step', 'false');
      throw new Error(
        `Fix SCA job submission failed with exit code ${cliExitCode}`
      );
    }

    // Fire-and-forget mode: backend handles job polling, PR creation, etc.
    if (FNF_MARKERS.some((marker) => cliOutput.includes(marker))) {
      core.setOutput('run-next-step', 'false');
      return { hasChanges: false, fireAndForget: true };
    }

    // Polling mode: check for changes and return results (CLI ran with --async --decouple)
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

      if (gitDiffOutput.trim().length > 0) {
        hasChanges = true;
      }
    } catch (error) {
      core.warning(`Failed to check git diff: ${error.message}`);
    }

    if (!hasChanges) {
      core.info('No changes to existing files detected. Skipping branch creation and PR.');
      return { hasChanges: false };
    }

    // Show git diff
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
    throw new Error(`Failed to run Fix for SCA: ${error.message}`);
  }
}

module.exports = runFixSca;