const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const github = require('@actions/github');
const setupAstGrep = require('./setup-ast-grep');
const runFixSca = require('./run-fix-sca');
const runFixSast = require('./run-fix-sast');
const createPr = require('./create-pr');
const uploadPrComment = require('./upload-pr-comment');
const fetchSastResultsBlob = require('./fetch-sast-results');

async function main() {
  try {
    // Get inputs
    const githubToken = core.getInput('github-token');
    const repository = core.getInput('repository');
    const branch = core.getInput('branch');
    const githubApiUrl = core.getInput('github-api-url');
    const prNumber = core.getInput('pr-number');
    const fnfFeatureFlag = core.getInput('fnf-feature-flag');
    const fixScaParams = core.getInput('fix-sca-params');
    const fixSastParams = core.getInput('fix-sast-params');
    const resultsBlobSha = core.getInput('results-blob-sha');

    core.info(`DEBUG: fixScaParams = "${fixScaParams}"`);
    core.info(`DEBUG: fixSastParams = "${fixSastParams}"`);

    // Determine if this is SAST or SCA fix
    const isSastFix = fixSastParams && fixSastParams.includes('SAST-');
    let paramsToUse = isSastFix ? fixSastParams : fixScaParams;



    // Nested: client_payload allows only 10 top-level properties
    const correlationId = github.context.payload.client_payload?.user_config?.correlation_id;

    const workspaceDir = process.env.GITHUB_WORKSPACE;
    const statusFilePath = path.join(workspaceDir, 'source-code', 'sca-fix-status');
    const actionPath = `${__dirname}/..`;
    const sourceCodeDir = path.join(workspaceDir, 'source-code');

    core.info('Starting Veracode Fix for SCA action...');

    // FNF needs a correlation_id for the callback; without one the run stays in polling mode
    const enableFnf = fnfFeatureFlag === 'true' && !!correlationId;

    // Setup ast-grep
    core.info('Setting up ast-grep...');
    await setupAstGrep(actionPath);

    let fixOutput = null;

    core.info('Running Fix for On the basis of comment...');
    if (isSastFix) {
      // Materialize the enriched results.json (full 1-results.json + fix_id) from the git
      // blob dispatched by veracode-github-app. Skipped if no blob SHA was provided, in
      // which case results.json is expected to already exist in veracode_artifact_directory.
      if (resultsBlobSha) {
        await fetchSastResultsBlob(workspaceDir, repository, githubToken, githubApiUrl, resultsBlobSha);
      } else {
        core.warning('No results-blob-sha provided; expecting results.json to already exist in veracode_artifact_directory');
      }

      core.info('Running SAST Fix...');
      fixOutput = await runFixSast(workspaceDir, actionPath, paramsToUse, sourceCodeDir);
      core.info(`SAST Fix Result: hasChanges=${fixOutput.hasChanges}, hasBatchResponse=${!!fixOutput.batchFixResponse}`);
    } else {
      try {
        fixOutput = await runFixSca(workspaceDir, actionPath, fixScaParams, enableFnf, correlationId);
      } catch (fixScaError) {
        core.error(`Fix for SCA failed: ${fixScaError.message}`);
        core.setOutput('run-next-step', 'false');
        throw fixScaError;
      }
      // Fire-and-forget mode: exit early, backend handles everything
      if (fixOutput.fireAndForget) {
        return;
      }
    }

    if (!fixOutput.hasChanges) {
      core.info('No changes detected. Skipping PR creation.');
      fs.writeFileSync(statusFilePath, 'NO_CHANGES_DETECTED', null, 2);
      // For SAST: still upload the batch response artifact so veracode-github-app
      // can post a "no changes" comment with detailed per-flaw outcomes.
      if (isSastFix && fixOutput.batchFixResponse) {
        await uploadPrComment(workspaceDir, repository, prNumber, githubToken, githubApiUrl, fixOutput.batchFixResponse);
      }
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
      sourceCodeDir,
      isSastFix ? fixOutput.batchFixResponse : null
    );

    // Post PR comment on original PR
    core.info('Posting comment on original PR...');
    await uploadPrComment(
      workspaceDir,
      repository,
      prNumber,
      githubToken,
      githubApiUrl,
      isSastFix ? fixOutput.batchFixResponse : null
    );

    core.info('Veracode Fix action completed successfully.');
  } catch (error) {
    core.setFailed(error.message);
    process.exit(1);
  }
}

main();
