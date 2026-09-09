const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const setupAstGrep = require('./setup-ast-grep');
const runFixSca = require('./run-fix-sca');
const runFixSast = require('./run-fix-sast');
const createPr = require('./create-pr');
const uploadPrComment = require('./upload-pr-comment');

async function main() {
  try {
    // Get inputs
    const githubToken = core.getInput('github-token');
    const repository = core.getInput('repository');
    const branch = core.getInput('branch');
    const githubApiUrl = core.getInput('github-api-url');
    const prNumber = core.getInput('pr-number');
    const fixScaParams = core.getInput('fix-sca-params');

    const workspaceDir = process.env.GITHUB_WORKSPACE;
    const statusFilePath = path.join(workspaceDir, 'source-code', 'sca-fix-status');
    const actionPath = `${__dirname}/..`
    const sourceCodeDir = path.join(workspaceDir, 'source-code');

    core.info('Starting Veracode Fix for SCA action...');

    // Setup ast-grep
    core.info('Setting up ast-grep...');
    await setupAstGrep(actionPath);

    const result = await runFixSast(workspaceDir, actionPath, fixScaParams, sourceCodeDir);
    core.info(`Result: ${JSON.stringify(result)}`);
    // Run Fix for SCA
    core.info('Running Fix for SCA...');
    const fixScaOutput = await runFixSca(workspaceDir, actionPath, fixScaParams, sourceCodeDir);
    
    if (!fixScaOutput.hasChanges) {
      core.info('No changes detected. Skipping PR creation.');
      fs.writeFileSync(statusFilePath, 'NO_CHANGES_DETECTED', null, 2);
      return;
    }

    // Create Pull Request
    core.info('Creating pull request...');
    const prCreateOutput = await createPr(
      workspaceDir,
      repository,
      branch,
      githubToken,
      githubApiUrl,
      sourceCodeDir
    );

    // Post PR comment on original PR
    core.info('Posting comment on original PR...');
    await uploadPrComment(
      workspaceDir,
      repository,
      prNumber,
      githubToken,
      githubApiUrl
    );

    core.info('Veracode Fix for SCA action completed successfully.');
  } catch (error) {
    core.setFailed(error.message);
    process.exit(1);
  }
}

main();
