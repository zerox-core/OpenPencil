export function documentNameFromFigPath(path: string): string {
  return (
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.fig$/i, '') ?? '未命名'
  )
}

export function downloadNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? '未命名.fig'
}

export function figDownloadName(fileName: string, sourceFormat: string): string {
  return sourceFormat === 'fig' ? fileName : fileName.replace(/\.[^.]+$/i, '.fig')
}
