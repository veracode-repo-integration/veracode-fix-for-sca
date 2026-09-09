const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('@actions/core');
const exec = require('@actions/exec');

async function runFixSast(workspaceDir, actionPath, fixScaParams, sourceCodeDir) {
  try {
    // Read and log results.json for debugging
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

    // Build command arguments
    const args = [
      'fix',
      'sast',
      sourceCodeDir,
      '--results',
      path.join(
        workspaceDir,
        'veracode_artifact_directory',
        'results.json'
      ),
      '--async',
      '--decouple',
      'true',
    ];

    core.info('--------- Running inside fix for sast ---------');
    // Conditionally add --remote flag (default: false)
    const fixRemote = core.getInput('fix-remote');
    if (fixRemote?.toLowerCase() === 'true') {
      core.info(`remote argument appended`)
      args.push('--remote');
    }

    return { hasChanges: true };
  } catch (error) {
    throw new Error(`Failed to run Fix for SAST: ${error.message}`);
  }
}

module.exports = runFixSast;
