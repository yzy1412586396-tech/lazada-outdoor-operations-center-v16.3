const path = require('path');

function configureDownloadItem(item, downloadsDirectory) {
  if (!item || typeof item.getFilename !== 'function' || typeof item.setSaveDialogOptions !== 'function') {
    throw new TypeError('Invalid Electron DownloadItem');
  }
  if (typeof downloadsDirectory !== 'string' || !downloadsDirectory.trim()) {
    throw new TypeError('Invalid downloads directory');
  }

  const filename = path.basename(item.getFilename() || '导出文件');
  const options = {
    title: '保存导出文件',
    defaultPath: path.join(downloadsDirectory, filename),
    buttonLabel: '保存',
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  };

  // Electron shows this native dialog itself. Opening another dialog here
  // races with Chromium's download dialog and produces two save windows.
  item.setSaveDialogOptions(options);
  return options;
}

module.exports = { configureDownloadItem };
