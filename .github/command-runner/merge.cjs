module.exports = async ({ github, context, command, core, commentId }) => {
  const Comment = require('./comment.cjs')
  const comment = new Comment({ github, context, commentId })

  if (command === 'merge') {
    console.log('Run merge')
		let pendingReview = await github.rest.pulls.createReview({
			...context.repo,
			pull_number: context.issue.number,
		})

		await github.rest.pulls.submitReview({
			...context.repo,
			pull_number: context.issue.number,
			event: 'APPROVE',
			review_id: pendingReview.data.id
		})

		const { repository } = await graphqlWithAuth(`
      query($owner: String!, $repo: String!, $pullNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pullNumber) {
            id
          }
        }
      }
    `, {
      owner,
      repo,
      pullNumber,
    })

		const pullRequestId = repository.pullRequest.id

    await github.graphql(`
      mutation($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
          pullRequest {
            autoMergeRequest {
              enabledAt
            }
          }
        }
      }
    `, {
			pullRequestId: pullRequestId
		})
    await comment.createOrUpdateComment(`    Auto-merge enabled`)
    core.info('Auto-merge enabled')
    return
  }

  if (command === 'cancel-merge') {
    console.log('Run cancel-merge')
		await github.rest.pulls.submitReview({
			...context.repo,
			pull_number: context.issue.number,
			event: 'REQUEST_CHANGES',
			body: 'Dismissed'
		})

		const { repository } = await graphqlWithAuth(`
      query($owner: String!, $repo: String!, $pullNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pullNumber) {
            id
          }
        }
      }
    `, {
      owner,
      repo,
      pullNumber,
    })

		const pullRequestId = repository.pullRequest.id

    await github.graphql(`
      mutation($pullRequestId: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
          pullRequest {
            autoMergeRequest {
              disabledAt
            }
          }
        }
    `, {
			pullRequestId: pullRequestId
		})
    await comment.createOrUpdateComment(`    Auto-merge disabled`)

    core.info('Auto-merge disabled')
    return
  }
}
