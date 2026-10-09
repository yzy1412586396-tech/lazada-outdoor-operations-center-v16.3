const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const PE = require('pe-library');
const RE = require('resedit');
const appVersion = require('../package.json').version;
const nativeVersion = appVersion.split('.').concat('0').slice(0, 4).join('.');

module.exports = async (context) => {
  if (context.electronPlatformName !== 'win32') return;
  const appName = context.packager.appInfo.productFilename;
  const target = path.join(context.appOutDir, `${appName}.exe`);
  const exe = PE.NtExecutable.from(fs.readFileSync(target));
  const resources = PE.NtExecutableResource.from(exe);
  // Preserve manifest and Electron ASAR integrity resource bytes exactly.
  const unchanged = resources.entries.filter(e => ![3,14,16].includes(e.type)).map(e => ({ ...e, bin: Buffer.from(e.bin) }));
  const icon = RE.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico')));
  const groups = RE.Resource.IconGroupEntry.fromEntries(resources.entries);
  if (!groups.length) throw new Error('Executable has no icon resource');
  for (const group of groups) RE.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icon.icons.map(i => i.data));
  const versions = RE.Resource.VersionInfo.fromEntries(resources.entries);
  if (!versions.length) throw new Error('Executable has no version resource');
  for (const version of versions) {
    for (const language of version.getAllLanguagesForStringValues()) {
      version.setFileVersion(nativeVersion, language.lang);
      version.setProductVersion(nativeVersion, language.lang);
      version.setStringValues(language, { FileDescription: appName, ProductName: appName, CompanyName: appName, OriginalFilename: `${appName}.exe`, InternalName: appName });
    }
    version.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(exe);
  const output = Buffer.from(exe.generate());
  const check = PE.NtExecutableResource.from(PE.NtExecutable.from(output));
  for (const entry of unchanged) {
    const actual = check.entries.find(e => e.type === entry.type && e.id === entry.id && e.lang === entry.lang);
    assert(actual, 'Resource disappeared');
    assert.deepEqual(Buffer.from(actual.bin), entry.bin, 'Non-icon/version resource changed');
  }
  for (const group of RE.Resource.IconGroupEntry.fromEntries(check.entries)) {
    const actual = group.getIconItemsFromEntries(check.entries);
    assert.equal(actual.length, icon.icons.length);
    actual.forEach((item, index) => assert.deepEqual(Buffer.from(item.isRaw() ? item.bin : item.generate()), Buffer.from(icon.icons[index].data.isRaw() ? icon.icons[index].data.bin : icon.icons[index].data.generate())));
  }
  const temporary = `${target}.resources-tmp`;
  fs.writeFileSync(temporary, output);
  fs.renameSync(temporary, target);
  console.log(`Windows executable icon and ${appVersion} resources verified; manifest/ASAR resources preserved.`);
};
