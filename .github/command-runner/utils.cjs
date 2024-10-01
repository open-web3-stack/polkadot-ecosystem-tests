function createResult({ command, context, result, extra }) {
  return `**Request**: \`${context.payload.comment.body.trim()}\`
**Command**: \`${command}\`
${extra}

<details>
<summary>Results</summary>

\`\`\`
${result}
\`\`\`
</details>
`
}

async function runCommand({ cmd, comment, exec }) {
  let output = '';
  let errorOutput = '';
  await comment.createOrUpdateComment(`Running: \`${cmd}\``)

  const exitCode = await exec.exec(cmd, null, {
    ignoreReturnCode: true,
    listeners: {
      stdline: (data) => {
        output += `${data}\n`;
      },
      errline: (data) => {
        errorOutput += `${data}\n`;
      }
    }
  });

  return {
    output: output.replace(/\x1b\[[0-9;]*m/g, ''),
    errorOutput: errorOutput.replace(/\x1b\[[0-9;]*m/g, ''),
    exitCode,
    cmd,
  }
}

function parseEnv(lines) {
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

function readEnv() {
  const fs = require('fs')
  const envContent = fs.readFileSync('KNOWN_GOOD_BLOCK_NUMBERS.env', 'utf8')
  return envContent.toString()
}

function writeNewEnv({ env }) {
  const fs = require('fs')
  const inputEnv = parseEnv((env || '').split('\n'))

  const currentEnv = parseEnv(readEnv().split('\n'))
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
    console.log(`Write new env, 'utf8')}`)
    return readEnv()
  } else {
    console.log(`No env have changed`)
    return ''
  }
}

module.exports = {
  createResult,
  runCommand,
  parseEnv,
  writeNewEnv
}