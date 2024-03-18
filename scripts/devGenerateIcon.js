import fs from 'node:fs'
import {exec} from 'node:child_process'

const file = 'scripts/generateIcon.js'

console.log(`Watching for file changes in ${file}`)

fs.watch(file, async () => {
    console.log('Generating icon...')
    exec('node scripts/generateIcon.js', (err, stdout, stderr) => {
        if (err) {
            console.error(stderr)
            console.error(err)
        }
    })
    console.log('Generated icon saved.')
})
