'use strict'

const _ = require('lodash')
const fs = require('fs-extra')
const path = require('path')
const tmp = require('tmp-promise')
const decompress = require('decompress')
const fetch = require('node-fetch')
const yargs = require('yargs')

const utils = require('./lib/utils')

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
        'Microsoft.Net.4.6.1.FullRedist.NonThreshold',
        'Microsoft.VisualStudio.Initializer',
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

async function installVsix({ pkg, payloadsDir, dst, isDryRun }) {
    
    if (isDryRun) {
        console.log(`Would download and install Vsix ${pkg.name}`)
        return
    }
    
    const zipPath = path.join(payloadsDir, pkg.payloads[0].url)
    
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

async function installMsi({ pkg, payloadsDir, dst, isDryRun }) {
    
    console.log(`Downloading ${pkg.name}`)
    
    const msiPayload = _.find(pkg.payloads, payload => _.endsWith(payload.fileName, 'msi'))
    
    const replacements = {
        '[LogFile]': `C:\\Users\\wineuser\\Temp\\${pkg.name}.log`,
        '[Payload]': msiPayload.fileName,
        '[CEIPConsent]': '',
        '[CustomInstallPath]': dst,
        '[SharedInstallDir]': 'C:\\Program Files'
    }
    const installParams = _.mapValues(pkg.msiProperties || {}, (paramValue, paramKey) => {
        return replacements[paramValue] || paramValue
    })
    
    console.log(`Installing ${pkg.name}`)
    await utils.runCommand('msiexec', [
        '/i', path.join(payloadsDir, msiPayload.fileName),
        ..._.map(installParams, (value, key) => `${key}=${value}`),
        '/qn',
    ], {
        env: {
            ...process.env,
            WINEDEBUG: '-all,+msiexec'
        },
        isDryRun
    })
}

async function installExe({ pkg, payloadsDir, dst, isDryRun }) {
    
    const payload = pkg.payloads[0]
    
    const replacements = {
        '[LogFile]': `C:\\Users\\wineuser\\Temp\\${pkg.name}.log`,
        '[Payload]': payload.fileName,
        '[CEIPConsent]': '',
        '[CustomInstallPath]': dst,
        '[SharedInstallDir]': 'C:\\Program Files'
    }
    const installParams = _.map(pkg.installParams.parameters.split(' '), param => {
        _.forEach(replacements, (replacementValue, replacementKey) => {
            const regex = new RegExp(_.escapeRegExp(replacementKey), 'g')
            param = param.replace(regex, replacementValue)
        })
        return param
    })
    
    console.log(`Installing ${pkg.name}`)
    await utils.runCommand('wine', [
        path.join(payloadsDir, payload.fileName),
        ...installParams
    ], {
        shell: true,
        isDryRun
    })
}

async function installPackages({ packages, dst, isDryRun }) {
    
    const { path: downloadDir } = await tmp.dir({ unsafeCleanup: true })
    
    // Compile a list of all the files to download
    const files = _.flatten(_.map(packages, pkg => {
        return _.map(pkg.payloads || [], payload => {
            return {
                src: payload.url,
                dst: path.join(downloadDir, pkg.name, path.basename(payload.fileName))
            }
        })
    }))
    
    await utils.downloadFiles({
        files,
        isDryRun
    })
    
    for (const pkg in packages) {
        const payloadsDir = path.join(downloadDir, pkg.name)
        switch (pkg.type.toLowerCase()) {
            case 'vsix':
                return installVsix({ pkg, payloadsDir, dst, isDryRun })
            case 'exe':
                return installExe({ pkg, payloadsDir, dst, isDryRun })
            case 'msi':
                return installMsi({ pkg, payloadsDir, dst, isDryRun })
            default:
                console.log(`Ignoring installation steps for package type ${pkg.type}`)
        }
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
    await installPackages({
        packages: uniquePackages,
        dst: installDirFullPath,
        isDryRun
    })
}

yargs
.usage('$0 --install-dir <path>')
.option('install-dir', {
    describe: 'Installation directory for VC Build Tools',
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
