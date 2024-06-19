function build() {
  return require('esbuild')
    .build({
      entryPoints: ['./src/cli.ts'],
      outfile: './dist/cli.js',
      // outdir: config.outdir,
      bundle: true,
      platform: 'node',
      target: 'es2022',
      external: ['node:fs', 'prettier', 'esbuild', 'shelljs'],
      sourcemap: true,
      logOverride: {
        'direct-eval': 'info',
      },
      plugins: require('./esbuild-plugins'),
    })
    .catch(() => process.exit(1));
}

build();
