const fs = require('fs');
const path = require('path');
const core = require('@actions/core');
const exec = require('@actions/exec');
const github = require('@actions/github');
const { DefaultArtifactClient } = require('@actions/artifact');

async function uploadPrComment(workspaceDir, repository, prNumber, githubToken, githubApiUrl, batchFixResponse = null, severityMap = null) {
  try {
    // Parse repository string (format: owner/repo)
    const [owner, repo] = repository.split('/');
    if (!owner || !repo) {
      throw new Error(`Invalid repository format. Expected 'owner/repo', got '${repository}'`);
    }

    let commentBody;
    // Hoisted so they are accessible when building artifactData below
    let fixPrNumber = null;
    let fixPrUrl = null;

    if (batchFixResponse) {
      // Read the PR response file to get the newly created PR URL/number (may not exist
      // if there were no git changes; that is fine — we still post the outcomes comment).
      const prResponseFilePath = path.join(workspaceDir, 'github_fix_pr_post_response.json');
      if (fs.existsSync(prResponseFilePath)) {
        try {
          const prResponseData = JSON.parse(fs.readFileSync(prResponseFilePath, 'utf8'));
          fixPrUrl = prResponseData.html_url || null;
          fixPrNumber = prResponseData.number || null;
        } catch (e) {
          core.warning(`Could not read PR response file: ${e.message}`);
        }
      }
      commentBody = generateSastCommentBody(batchFixResponse, fixPrNumber, fixPrUrl);
    } else {
      // SCA path: read from the existing github_fix_pr_post_response.json
      const resultsFilePath = path.join(workspaceDir, 'github_fix_pr_post_response.json');
      if (!fs.existsSync(resultsFilePath)) {
        core.warning(`Fix PR response file not found at ${resultsFilePath}. Skipping comment post.`);
        return;
      }
      commentBody = generateDefaultCommentBody(fs.readFileSync(resultsFilePath, 'utf8'));
    }

    if (!commentBody || commentBody.trim().length === 0) {
      core.warning('Comment body is empty. Skipping comment post.');
      return;
    }

    core.info(`Upload comment to PR #${prNumber} as an artifact...`);

    // Upload PR comment data as artifact.
    // Include the raw batch fix response so veracode-github-app can re-generate
    // the comment body server-side with its own formatting logic.
    const artifactData = {
      repository_owner: owner,
      repository_name: repo,
      issue_number: parseInt(prNumber),
      body: commentBody,
      ...(batchFixResponse && {
        batch_fix_response: batchFixResponse,
        fix_pr_number: fixPrNumber,
        fix_pr_url: fixPrUrl,
        ...(severityMap && { severity_map: severityMap })
      })
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

/**
 * Build a rich markdown comment for the original PR from the CLI batch fix response (v2 schema).
 * @param {object} batchFixResponse - The parsed batch fix response (batchFixResponse.patch or root)
 * @param {number|null} fixPrNumber - Number of the newly created fix PR (may be null)
 * @param {string|null} fixPrUrl - HTML URL of the newly created fix PR (may be null)
 */
function generateSastCommentBody(batchFixResponse, fixPrNumber, fixPrUrl) {
  const s = batchFixResponse?.summary || {};
  const patches = batchFixResponse?.patches || [];
  const flaws = batchFixResponse?.flaws || [];
  const status = batchFixResponse?.status || 'COMPLETED';

  let body = '## Veracode Fix for SAST\n\n';

  if (fixPrNumber && fixPrUrl) {
    body += `**Fix PR:** [#${fixPrNumber}](${fixPrUrl})\n\n`;
  }

  const isCompleted = status === 'COMPLETED' || status === 'COMPLETED_WITH_ERRORS';
  const isFailed = status === 'FAILED';

  if (isFailed) {
    const diagnostic = batchFixResponse?.diagnostics?.[0];
    body += `❌ **Remote fix failed.**`;
    if (diagnostic?.message) body += ` ${diagnostic.message}`;
    body += '\n\n';
    return body;
  }

  if (!isCompleted || s.flawsInPatches === 0) {
    body += `ℹ️ No automated fixes were generated for the submitted findings.\n\n`;
  } else {
    body += `✅ **${s.flawsInPatches} finding(s)** included in **${s.patchCount} patch(es)** across **${s.filesTouched} file(s)**.\n\n`;
  }

  // Per-patch breakdown
  if (patches.length > 0) {
    body += '### Patches\n\n';
    for (const patch of patches) {
      const fileList = (patch.files || []).map(f => `\`${f.path}\``).join(', ');
      body += `**${patch.patchId}** — ${fileList}\n`;
      if (patch.suggestedCommitMessage) {
        body += `> ${patch.suggestedCommitMessage}\n`;
      }
      if (patch.explanation) {
        body += `${patch.explanation}\n`;
      }
      body += '\n';
    }
  }

  // Not attempted
  const notAttempted = flaws.filter(f => f.outcome === 'NOT_ATTEMPTED');
  if (notAttempted.length > 0) {
    body += `### Not Attempted (${notAttempted.length})\n\n`;
    body += '| Issue ID | File | Line | Reason |\n|---|---|---|---|\n';
    for (const f of notAttempted) {
      body += `| ${f.issueId} | \`${f.path}\` | ${f.line} | ${f.message || f.reason || ''} |\n`;
    }
    body += '\n';
  }

  // Failed attempts
  const failed = flaws.filter(f => f.outcome === 'ATTEMPT_FAILED');
  if (failed.length > 0) {
    body += `### Failed (${failed.length})\n\n`;
    body += '| Issue ID | File | Line | Reason |\n|---|---|---|---|\n';
    for (const f of failed) {
      body += `| ${f.issueId} | \`${f.path}\` | ${f.line} | ${f.message || f.reason || ''} |\n`;
    }
    body += '\n';
  }

  body += '### Next Steps\n';
  if (fixPrNumber) {
    body += `1. Review and merge the fix PR [#${fixPrNumber}](${fixPrUrl}).\n`;
    body += '2. Run your test suite to confirm no regressions.\n';
    body += '3. Re-run the SAST scan to verify findings are resolved.\n';
  } else {
    body += '1. Re-run the SAST scan to verify findings are resolved.\n';
  }

  return body;
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
