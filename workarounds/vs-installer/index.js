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
const Papa = require('papaparse')
const yargs = require('yargs')

async function downloadFile({ src, dst, isDryRun }) {
    
    console.log(`Downloading ${src}`)
    
    if (isDryRun) {
        return
    }
    
    const downloadPromise = download(src)
    downloadPromise.pipe(fs.createWriteStream(dst))
    await downloadPromise
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

async function installVsix({ pkg, dst, isDryRun }) {
    
    if (isDryRun) {
        console.log(`Would download and install Vsix ${pkg.name}`)
        return
    }
    
    const { path: zipPath } = await tmp.file()
    const url = pkg.payloads[0].url
    
    console.log(`Downloading ${pkg.name}`)
    await downloadFile({ src: url, dst: zipPath, isDryRun })
    await Promise.delay(0.5)
    
    console.log(`Decompressing ${pkg.name}`)
    if (!isDryRun) {
        await decompress(zipPath, dst, {
            filter: file => _.startsWith(file.path, 'Contents/'),
            map: file => {
                file.path = file.path.split('Contents/')[1].replace('%20', ' ')
                return file
            }
        })
    }
}

async function installMsi({ pkg, dst, isDryRun }) {
    
    console.log(`Downloading ${pkg.name}`)
    const { path: downloadDir } = await tmp.dir()
    for (const payload of pkg.payloads) {
        await downloadFile({
            src: payload.url,
            dst: path.join(downloadDir, payload.fileName),
            isDryRun
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
        },
        isDryRun
    })
}

async function installExe({ pkg, dst, isDryRun }) {
    
    const { path: downloadDir } = await tmp.dir()
    
    console.log(`Downloading ${pkg.name}`)
    const payload = pkg.payloads[0]
    await downloadFile({
        src: payload.url,
        dst: path.join(downloadDir, payload.fileName),
        isDryRun
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
        isDryRun
    })
}

async function installPackage({ pkg, dst, isDryRun }) {
    switch (pkg.type.toLowerCase()) {
        case 'vsix':
            return installVsix({ pkg, dst, isDryRun })
        case 'exe':
            return installExe({ pkg, dst, isDryRun })
        case 'msi':
            return installMsi({ pkg, dst, isDryRun })
        default:
            console.log(`Ignoring installation steps for package type ${pkg.type}`)
    }
}

async function installWindowsSDK({ catalogJson, isDryRun }) {
    
    console.log('Downloading & Installing Windows SDK')
    
    const toolsPackage = _.find(catalogJson.packages, pkg => pkg.id === 'Microsoft.VisualStudio.Workload.VCTools')
    const winSdkDependency = _.first(_.keys(
        _.pickBy(toolsPackage.dependencies, (depObject, depId) => {
            if (!_.isObject(depObject)) {
                return false
            }
            return depObject.type.toLowerCase() === 'recommended'
                && _.startsWith(depId, 'Microsoft.VisualStudio.Component.Windows10SDK')
        })
    ))
    const winSdkVersion = _.last(winSdkDependency.split('.'))
    console.log(`Windows SDK version ${winSdkVersion}`)
    
    const exePackage = _.find(catalogJson.packages, pkg => pkg.id === `Win10SDK_10.0.${winSdkVersion}`)
    
    // To get a list of available Windows SDK components, run:
    // $ cat channel.vsman.json | jq '.packages[] | select(.id =="Win10SDK_10.0.17763") | .payloads[].fileName' | grep -i msi
    const msiNames = [
        'Windows SDK-x86_en-us.msi',
        'Windows SDK Modern Versioned Developer Tools-x86_en-us.msi',
        'Windows SDK Desktop Headers x64-x86_en-us.msi',
        'Windows SDK Desktop Headers x86-x86_en-us.msi',
        'Windows SDK Desktop Libs x64-x86_en-us.msi',
        'Windows SDK Desktop Libs x86-x86_en-us.msi',
        'Windows SDK Desktop Tools x64-x86_en-us.msi',
        'Windows SDK Desktop Tools x86-x86_en-us.msi',
        'Windows SDK for Windows Store Apps Headers-x86_en-us.msi',
        'Windows SDK for Windows Store Apps Libs-x86_en-us.msi',
        'Windows SDK for Windows Store Apps Tools-x86_en-us.msi',
        'Windows SDK for Windows Store Apps Legacy Tools-x86_en-us.msi',
        'Universal CRT Headers Libraries and Sources-x86_en-us.msi',
    ]
    
    for (const msiName of msiNames) {
        const msiPayload = _.find(exePackage.payloads, payload => _.endsWith(payload.fileName, msiName))
        
        console.log(`Downloading ${msiName}`)
        const { path: downloadDir } = await tmp.dir()
        await downloadFile({
            src: msiPayload.url,
            dst: path.join(downloadDir, msiName),
            isDryRun
        })
        
        console.log(`Inspecting ${msiName}`)
        if (!isDryRun) {
            const output = await runCommand('msiinfo', [
                'export',
                path.join(downloadDir, msiName),
                'Media'
            ])
            
            const medias = Papa.parse(output.stdout, { header: true })
            const cabNames = _.map(_.filter(medias.data, media => {
                return !_.startsWith(media.Cabinet, '#') && _.endsWith(media.Cabinet, '.cab')
            }), 'Cabinet')
            
            for (const cabName of cabNames) {
                const cabPayload = _.find(exePackage.payloads, payload => _.endsWith(payload.fileName, cabName))
                
                console.log(`Downloading ${cabName}`)
                await downloadFile({
                    src: cabPayload.url,
                    dst: path.join(downloadDir, cabName),
                    isDryRun
                })
            }
        }
        
        console.log(`Installing ${msiName}`)
        await runCommand('msiexec', [
            '/i', path.join(downloadDir, msiName),
            '/qn',
        ], {
            env: {
                ...process.env,
                WINEDEBUG: '-all,+msiexec'
            },
            isDryRun
        })
    }
}

async function run({ installDir, isDryRun }) {
    
    if (isDryRun) {
        console.log('Running installer in dry-run mode')
    }
    
    let installDirFullPath = null
    if (installDir) {
        installDirFullPath = path.resolve(installDir)
        if (!await fs.pathExists(installDirFullPath)) {
            throw new Error(`Installation directory ${installDirFullPath} does not exist`)
        }
    } else {
        const { path: tmpDir } = await tmp.dir()
        installDirFullPath = tmpDir
    }
    console.log('Installation directory', installDirFullPath)
    
    // Download manifest
    const manifestUrl = 'https://aka.ms/vs/15/release/channel'
    const manifest = await (await fetch(manifestUrl)).json()
    
    // Extract catalog url from manifest and download it
    // Eg: https://download.visualstudio.microsoft.com/download/pr/82e3dcda-e8a0-44e4-8860-eb93a12d4e80/61c5d0ed852e311c8fd6a62627fcb326da6aa79028b40ae25ee062da3c33791b/VisualStudio.vsman
    const catalog = _.find(manifest.channelItems, item => {
        return item.type.toLowerCase() === 'manifest' && item.id === 'Microsoft.VisualStudio.Manifests.VisualStudio'
    })
    const catalogUrl = catalog.payloads[0].url
    const catalogJson = await (await fetch(catalogUrl)).json()
    
    // Install Win SDK separately, because the installer won't work
    await installWindowsSDK({ catalogJson, isDryRun })
    
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
    
    // Support for UWP builds
    const uwpPackages = findPackageAndDependencies({
        json: onlyEnglish,
        id: 'Microsoft.VisualStudio.Workload.UniversalBuildTools'
    })
    
    // Gather all packages and generate a unique name
    const allPackages = _.map([
        ...vcToolsPackages,
        ...buildToolsPackages,
        ...uwpPackages
    ], pkg => {
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
        await installPackage({ pkg, dst: installDirFullPath, isDryRun })
    }
}

yargs
.usage('$0 --install-dir <path>')
.option('install-dir', {
    describe: 'Installation directory for VC Build Tools. Does not affect Windows SDK & other Frameworks.',
})
.option('dry-run', {
    describe: 'Run the installer without downloading or installing components',
    type: 'boolean'
})
.conflicts('dry-run', 'install-dir')

const args = yargs.argv

if (!args.dryRun && !args.installDir) {
    throw new Error('--install-dir must be provided during real runs')
}

run({
    installDir: args.installDir,
    isDryRun: args.dryRun || false
}).catch(err => {
    console.error(err.stack)
    process.exit(1)
})
