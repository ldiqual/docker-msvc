'use strict'

const execa = require('execa')
const download = require('download')
const fs = require('fs-extra')
const path = require('path')
const tmp = require('tmp-promise')

async function downloadFile({ src, dst, isDryRun }) {
    
    console.log(`Downloading ${src}`)
    
    if (isDryRun) {
        return
    }
    
    const downloadPromise = download(src)
    downloadPromise.pipe(fs.createWriteStream(dst))
    await downloadPromise
}

// files is an array of objects containing {src, dst}
async function downloadFiles({ files, isDryRun }) {
    
    console.log(`Downloading ${files.length} files`)
    
    const { path: fileListPath } = await tmp.file()
    
    // Write this list to "aria2.files"
    let aria2FilesList = ''
    for (const file of files) {
        aria2FilesList += file.src + '\n'
        aria2FilesList += `\tdir=${path.dirname(file.dst)}\n`
        aria2FilesList += `\tout=${path.basename(file.dst)}\n`
    }
    await fs.writeFile(fileListPath, aria2FilesList, 'utf8')
    
    // Delegate the downloading to aria2c for super-fast downloads
    if (isDryRun) {
        console.log('Would download files', files)
        return
    }
    
    await runCommand('aria2c', [
        '--input-file', fileListPath
    ])
}

async function runCommand(path, args, options) {
    
    console.log(`Running ${path} ${args.join(' ')}`)
    
    options = options || {}
    if (options.isDryRun) {
        return
    }
    
    const promise = execa(path, args, options)
    promise.stdout.pipe(process.stdout)
    promise.stderr.pipe(process.stderr)
    return promise
}

module.exports = {
    downloadFile,
    runCommand,
    downloadFiles
}
