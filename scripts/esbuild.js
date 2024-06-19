function build() {
  return require('esbuild')
    .build({
      entryPoints: ['./src/cli.ts'],
      outfile: './dist/cli.js',
      // outdir: config.outdir,
      bundle: true,
      platform: 'node',
      target: 'es2022',
      external: ['node:fs', 'prettier', 'node:stream', 'ssh2', 'canvas'],
      sourcemap: true,
      plugins: require('./esbuild-plugins'),
    })
    .catch(() => process.exit(1));
}

build();
