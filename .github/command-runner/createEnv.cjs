const getEnv = (lines) => {
  const env = {}
  for (const line of lines) {
    if (typeof line === 'string') {
      const [key, value] = line.split('=');
      if (key && !isNaN(value)) {
        env[key.trim()] = parseInt(value, 10);
      }
    }
  }
  return env
}

module.exports = async ({ github, context, env, commentId }) => {
  const Comment = require('./comment.cjs')
  const comment = new Comment({ github, context, commentId })

  const fs = require('fs')

  const inputEnv = getEnv((env || '').split('\n'))

  const envContent = fs.readFileSync('KNOWN_GOOD_BLOCK_NUMBERS.env', 'utf8')
  const currentEnv = getEnv(envContent.toString().split('\n'))

  const newEnv = {}

  let updated = false
  for (const [key, value] of Object.entries(currentEnv)) {
    if (inputEnv[key] && inputEnv[value] !== value) {
      updated = true
      newEnv[key] = inputEnv[key]
    } else {
      newEnv[key] = value
    }
  }

  if (updated) {
    let newEnvContent = ''
    for (const [key, value] of Object.entries(newEnv)) {
      newEnvContent += `${key}=${value}\n`
    }

    fs.writeFileSync('KNOWN_GOOD_BLOCK_NUMBERS.env', newEnvContent)
    console.log(`new env ${fs.readFileSync('KNOWN_GOOD_BLOCK_NUMBERS.env', 'utf8')}`)
    return true
  } else {
    await comment.createOrUpdateComment(`    The env have not changed`)
    return false
  }
}

