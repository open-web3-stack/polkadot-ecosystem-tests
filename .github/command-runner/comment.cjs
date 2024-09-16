module.exports = class Comment {
  constructor({ github, context, commentId }) {
    this.github = github
    this.context = context
    this.commentId = commentId || null;
  }

  async createOrUpdateComment(body) {
    const actionUrl = `https://github.com/${ this.context.payload.repository.full_name }/actions/runs/${ this.context.runId }`
    if (!this.commentId) {
      const result = await this.github.rest.issues.createComment({
        issue_number: this.context.issue.number,
        owner: this.context.repo.owner,
        repo: this.context.repo.repo,
        body: `${body}

Workflow: ${actionUrl}`
      })
      this.commentId = result.data.id
    }
    await this.github.rest.issues.updateComment({
      comment_id: this.commentId,
      issue_number: this.context.issue.number,
      owner: this.context.repo.owner,
      repo: this.context.repo.repo,
      body: `${body}

Workflow: ${actionUrl}`
    })
  }
}