'use strict'

const _ = require('lodash')
const fs = require('fs-extra')
const Promise = require('bluebird')
const path = require('path')
const tmp = require('tmp-promise')
const decompress = require('decompress')
const download = require('download')
const fetch = require('node-fetch')
const execa = require('execa')

async function downloadFile({ src, dst }) {
    console.log(`Downloading ${src}`)
    const downloadPromise = download(src)
    downloadPromise.pipe(fs.createWriteStream(dst))
    await downloadPromise
}

async function runCommand(path, args, options) {
    console.log(`Running ${path} ${args.join(' ')}`)
    const promise = execa(path, args, options)
    promise.stdout.pipe(process.stdout)
    promise.stderr.pipe(process.stderr)
    return promise
}

function findPackageAndDependencies({ json, id, chip }) {
    
    const packages = _.filter(json.packages, pkg => {
                
        const hasSameId = pkg.id.toLowerCase() === id.toLowerCase()
        if (!hasSameId) {
            return false
        }
        
        if (chip) {
            const hasSameChip = pkg.chip.toLowerCase() === chip.toLowerCase()
            const isChipNeutral = pkg.chip.toLowerCase() === 'neutral'
            return hasSameChip || isChipNeutral
        }
        
        if (pkg.chip && _.includes(['x64', 'arm64'], pkg.chip.toLowerCase())) {
            return false
        }
        
        return true
    })
    
    const ignoredDependencies = [
        'Microsoft.Net.4.6.1.FullRedist.Threshold',
        'Microsoft.Net.4.6.1.FullRedist.NonThreshold'
    ]
    
    const dependencies = _.flatten(_.map(packages, pkg => {
        const filteredDependencies = _.pickBy(_.omit(pkg.dependencies, ignoredDependencies), dep => {
            if (dep.type && _.includes(['optional', 'recommended'], dep.type.toLowerCase())) {
                return false
            }
            if (dep.chip && _.includes(['x64', 'arm64'], dep.chip.toLowerCase())) {
                return false
            }
            return true
        })
        return _.flatten(_.map(filteredDependencies, (dep, depId) => {
            const chip = _.isObject(dep) ? dep.chip : null
            return findPackageAndDependencies({ json, id: depId, chip: chip })
        }))
    }))
    
    return [...packages, ...dependencies]
}

async function installVsix({ pkg, dst }) {
    
    const { path: zipPath } = await tmp.file()
    const url = pkg.payloads[0].url
    
    console.log(`Downloading ${pkg.name}`)
    await downloadFile({ src: url, dst: zipPath })
    await Promise.delay(0.5)
    
    console.log(`Decompressing ${pkg.name}`)
    await decompress(zipPath, dst, {
        filter: file => _.startsWith(file.path, 'Contents/'),
        map: file => {
            file.path = file.path.split('Contents/')[1].replace('%20', ' ')
            return file
        }
    })
}

async function installMsi({ pkg, dst }) {
    
    console.log(`Downloading ${pkg.name}`)
    const { path: downloadDir } = await tmp.dir()
    for (const payload of pkg.payloads) {
        await downloadFile({
            src: payload.url,
            dst: path.join(downloadDir, payload.fileName)
        })
    }
    
    console.log(`Installing ${pkg.name}`)
    const msiPayload = _.find(pkg.payloads, payload => _.endsWith(payload.fileName, 'msi'))
    const msiProperties = _.map(pkg.msiProperties || {}, (value, key) => `${key}=${value}`)
    await runCommand('msiexec', [
        '/i', path.join(downloadDir, msiPayload.fileName),
        ...msiProperties,
        '/qn',
    ], {
        env: {
            ...process.env,
            WINEDEBUG: '-all,+msiexec'
        }
    })
}

async function installExe({ pkg, dst }) {
    
    const { path: downloadDir } = await tmp.dir()
    
    console.log(`Downloading ${pkg.name}`)
    const payload = pkg.payloads[0]
    await downloadFile({
        src: payload.url,
        dst: path.join(downloadDir, payload.fileName)
    })
    
    const params = {
        '[LogFile]': `C:\\Users\\wineuser\\Temp\\${pkg.name}.log`,
        '[Payload]': payload.fileName,
        '[CEIPConsent]': ''
    }
    let installParams = pkg.installParams.parameters
    _.forEach(params, (value, key) => {
        const regex = new RegExp(_.escapeRegExp(key), 'g')
        installParams = installParams.replace(regex, value)
    })
    
    console.log(`Installing ${pkg.name}`)
    await runCommand('wine', [
        path.join(downloadDir, payload.fileName),
        ...installParams.split(' ')
    ], {
        shell: true,
    })
}

async function installPackage({ pkg, dst }) {
    switch (pkg.type.toLowerCase()) {
        case 'vsix':
            return installVsix({ pkg, dst })
        case 'exe':
            return installExe({ pkg, dst })
        case 'msi':
            return installMsi({ pkg, dst })
        default:
            console.log(`Ignoring installation steps for package type ${pkg.type}`)
    }
}

async function run() {
    
    let extractPath = process.argv.length > 2 ? path.resolve(_.last(process.argv)) : null
    if (extractPath === null) {
        const { path: tmpDir } = await tmp.dir()
        extractPath = tmpDir
    }
    console.log('Extraction path', extractPath)
    
    // Download manifest
    const manifestUrl = 'https://aka.ms/vs/15/release/channel'
    const manifest = await (await fetch(manifestUrl)).json()
    
    // Extract catalog url from manifest and download it
    const catalog = _.find(manifest.channelItems, item => {
        return item.type.toLowerCase() === 'manifest' && item.id === 'Microsoft.VisualStudio.Manifests.VisualStudio'
    })
    const catalogUrl = catalog.payloads[0].url
    const catalogJson = await (await fetch(catalogUrl)).json()
    
    // Only look for english or neutral packages
    const onlyEnglish = {
        ...catalogJson,
        packages: catalogJson.packages.filter(pkg => {
            return _.isUndefined(pkg.language) || pkg.language === 'en-US' || pkg.language === 'neutral'
        })
    }
    
    // Add VCTools
    const vcToolsPackages = findPackageAndDependencies({
        json: onlyEnglish,
        id: 'Microsoft.VisualStudio.Workload.VCTools'
    })
    
    // Add BuildTools
    const buildToolsPackages = findPackageAndDependencies({
        json: onlyEnglish,
        id: 'Microsoft.VisualStudio.Product.BuildTools'
    })
    
    // Gather all packages and generate a unique name
    const allPackages = _.map([...vcToolsPackages, ...buildToolsPackages], pkg => {
        return {
            ...pkg,
            name: `${pkg.id},${pkg.chip || 'neutral'},${pkg.version}`
        }
    })
    
    // Remove duplicates
    const uniquePackages = _.uniqBy(allPackages, 'name')
    
    console.log('Packages to install', _.map(uniquePackages, 'name'))
    
    // Install all packages
    for (const pkg of uniquePackages) {
        await installPackage({ pkg, dst: extractPath })
    }
}

run().catch(err => {
    console.error(err.stack)
    process.exit(1)
})
