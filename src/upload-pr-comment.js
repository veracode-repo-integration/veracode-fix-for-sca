const fs = require('fs');
const path = require('path');
const core = require('@actions/core');
const github = require('@actions/github');
const { DefaultArtifactClient } = require('@actions/artifact');

/**
 * Posts the PR comment for a completed fix run.
 *
 * SAST posts the comment directly to the original PR's conversation (this action already
 * holds a token with issues:write/pull_requests:write on the target repo, used by create-pr.js
 * to open the fix PR). SCA keeps uploading an artifact for veracode-github-app to post.
 */
async function uploadPrComment(workspaceDir, repository, prNumber, githubToken, githubApiUrl, sourceCodeDir, isSastFix = false, fixPrNumber = null, fixPrUrl = null) {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid repository format. Expected 'owner/repo', got '${repository}'`);
  }

  if (isSastFix) {
    await postSastCommentDirectly(owner, repo, prNumber, githubToken, sourceCodeDir, fixPrNumber, fixPrUrl);
    return;
  }

  try {
    const resultsFilePath = path.join(workspaceDir, 'github_fix_pr_post_response.json');
    if (!fs.existsSync(resultsFilePath)) {
      core.warning(`Fix PR response file not found at ${resultsFilePath}. Skipping comment post.`);
      return;
    }
    const commentBody = generateDefaultCommentBody(fs.readFileSync(resultsFilePath, 'utf8'));

    if (!commentBody || commentBody.trim().length === 0) {
      core.warning('Comment body is empty. Skipping comment post.');
      return;
    }

    core.info(`Upload comment to PR #${prNumber} as an artifact...`);

    const artifactData = {
      repository_owner: owner,
      repository_name: repo,
      issue_number: parseInt(prNumber),
      body: commentBody
    };

    const artifactDir = path.join(workspaceDir, 'veracode_artifact_directory');
    fs.mkdirSync(artifactDir, { recursive: true });
    const artifactFilePath = path.join(artifactDir, 'veracode-cli.pr-comment.json');
    fs.writeFileSync(artifactFilePath, JSON.stringify(artifactData, null, 2));

    core.info('== Start upload ==')
    const artifactClient = new DefaultArtifactClient();
    const artifactName = 'veracode-cli-pr-comment-json';
    const uploadResponse = await artifactClient.uploadArtifact(
      artifactName,
      [artifactFilePath],
      workspaceDir,
      { continueOnError: false }
    );
    core.info('== End upload ==')

    core.info(`Artifact uploaded successfully: ${uploadResponse?.artifactName || artifactName}`);
  } catch (artifactError) {
    core.warning(`Failed to upload artifact: ${artifactError.message}`);
    // Don't fail the action if uploading fails
  }
}

async function postSastCommentDirectly(owner, repo, prNumber, githubToken, sourceCodeDir, fixPrNumber, fixPrUrl) {
  try {
    const reportPath = path.join(sourceCodeDir, 'sast-fix-report.md');
    let commentBody;
    if (fs.existsSync(reportPath)) {
      commentBody = fs.readFileSync(reportPath, 'utf8');
    } else {
      core.warning(`sast-fix-report.md not found at ${reportPath}. Posting default comment.`);
      commentBody = '## Veracode Fix for SAST\n\nNo automated fixes were generated for the submitted findings.\n';
    }

    if (fixPrNumber && fixPrUrl) {
      commentBody += `\n\n**Fix PR:** [#${fixPrNumber}](${fixPrUrl})\n`;
    }

    const octokit = github.getOctokit(githubToken);
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: parseInt(prNumber, 10),
      body: commentBody
    });
    core.info(`Posted SAST fix comment directly to PR #${prNumber} in ${owner}/${repo}`);

    // Clean up now that both the PR body (create-pr.js) and this comment have used the report.
    try {
      if (fs.existsSync(reportPath)) {
        fs.unlinkSync(reportPath);
      }
    } catch (cleanupError) {
      core.warning(`Failed to clean up sast-fix-report.md: ${cleanupError.message}`);
    }
  } catch (error) {
    core.warning(`Failed to post SAST fix comment: ${error.message}`);
  }
}

function generateDefaultCommentBody(prResponseStr) {
  try {
    const prResponse = typeof prResponseStr === 'string' ? JSON.parse(prResponseStr) : prResponseStr;
    return `## Veracode Fix for SCA - Pull Request Created
**PR:** ${prResponse.html_url || 'N/A'}

This PR contains updates for vulnerable dependencies.

### Next Steps:
1. Review the changes in the Fix for SCA PR.
2. Verify that tests pass.
3. Merge the PR to apply the dependency updates.
4. Re-run the SCA scan to verify the fixes.`;
  } catch (error) {
    return 'A pull request has been created with automated fixes for Veracode SCA vulnerabilities. Please review the changes.';
  }
}

module.exports = uploadPrComment;
