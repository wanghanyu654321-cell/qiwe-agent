function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error('PROJECT_RESIDUE_ANCHOR_CHANGED');
  return source.replace(before, after);
}

/** Transform only the verified private appointment inventory source. */
export function applyProjectResidueOverlay(source) {
  let result = source.replaceAll('\r\n', '\n');
  result = replaceOnce(result,
    "  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;",
    "  const projectRoot = path.basename(dataDir) === 'data' ? path.dirname(dataDir) : undefined;\n" +
    "  if (!projectRoot) blockers.add('RESIDUE:PROJECT_ROOT_UNVERIFIED');\n" +
    "  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;");
  result = replaceOnce(result,
    "    if (root !== 'ipc') return root + (root === 'streaming-buffer' ? '/file' : '/opaque');",
    "    if (root === 'project/config') return 'project/config/file';\n" +
    "    if (root !== 'ipc') return root + (root === 'streaming-buffer' ? '/file' : '/opaque');");
  result = replaceOnce(result,
    "  function openData(): number {",
    "  function openDirectory(absolute: string): number {");
  result = replaceOnce(result,
    "      for (const segment of path.resolve(dataDir).split('/').filter(Boolean)) {",
    "      for (const segment of path.resolve(absolute).split('/').filter(Boolean)) {");
  result = replaceOnce(result,
    "    data = openData();",
    "    data = openDirectory(dataDir);");
  result = replaceOnce(result,
    "    const current = openData();",
    `    // The two scopes spend the same remainingRows, remainingBytes and deadline.
    // Project identity is derived only from an absolute .../data root, never
    // from a caller-supplied project path or an arbitrary scan directory.
    if (projectRoot) {
      let project: number | undefined;
      try {
        project = openDirectory(projectRoot);
        const projectBefore = version(fs.fstatSync(project, { bigint: true }));
        for (const [entry, family] of [['.env', 'env'], ['config', 'config']] as const) {
          const relative = 'project/' + entry;
          if (!budget(relative, 0)) break;
          const name = descriptor(project) + '/' + entry;
          let stat: fs.BigIntStats;
          try { stat = fs.lstatSync(name, { bigint: true }); }
          catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
              add(relative, 'project/' + family + '/root',
                digest(projectBefore + ':' + relative), 'root_absent');
            else failed(error);
            continue;
          }
          if (entry === '.env') {
            add(relative, stat.isFile() ? 'project/env/file' : 'project/env/unsafe',
              version(stat), stat.isFile() ? 'file_unsettled' : 'unsafe_entry');
            if (!stat.isFile()) blockers.add('RESIDUE:UNSAFE_ENTRY');
            try {
              if (version(fs.lstatSync(name, { bigint: true })) !== version(stat))
                blockers.add('RESIDUE:CHANGED_DURING_SCAN');
            } catch (error) { failed(error); }
            continue;
          }
          if (!stat.isDirectory()) {
            add(relative, 'project/config/unsafe', version(stat), 'unsafe_entry');
            blockers.add('RESIDUE:UNSAFE_ENTRY');
            continue;
          }
          let config: number | undefined;
          try {
            config = fs.openSync(name, flags);
            if (version(fs.fstatSync(config, { bigint: true })) !== version(stat))
              blockers.add('RESIDUE:CHANGED_DURING_SCAN');
            else walk(config, relative, 'project/config', 0);
            if (version(fs.lstatSync(name, { bigint: true })) !== version(stat))
              blockers.add('RESIDUE:CHANGED_DURING_SCAN');
          } catch (error) { failed(error); }
          finally { if (config !== undefined) fs.closeSync(config); }
        }
        const currentProject = openDirectory(projectRoot);
        try {
          if (version(fs.fstatSync(currentProject, { bigint: true })) !== projectBefore ||
              version(fs.fstatSync(project, { bigint: true })) !== projectBefore)
            blockers.add('RESIDUE:CHANGED_DURING_SCAN');
        } finally { fs.closeSync(currentProject); }
      } catch (error) { failed(error); }
      finally { if (project !== undefined) fs.closeSync(project); }
    }
    const current = openDirectory(dataDir);`);
  return result;
}
