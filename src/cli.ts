#!/usr/bin/env node
import {Command} from 'commander';
import fs from 'node:fs';
import esbuild from 'esbuild';
import shell from 'shelljs';
import dockerTemplate from './dockerTemplate.txt';

const program = new Command();
program.version('0.0.1');
type Config = {
  entry: string;
  esbuildPlugins: Array<any>;
  esbuildExternals: Array<string>;
  name: string;
  envs: {
    [key: string]: {
      aws: {
        profile: string;
        region: string;
      };
      env: {NODE_ENV: string};
    };
  };
  port: number;
  nodeVersion: number;
};
program
  .command('init')
  .description('Initialize a new project')
  .argument('<string>', 'project name')
  // .option('-n, --name <name>', 'Name of the project')
  // .option('-d, --description <description>', 'Description of the project')
  .action((str, options) => {
    if (fs.existsSync('config.js')) {
      console.error('Project already exists');
      return;
    }
    console.log('Creating a new project...');
    // console.log('Name:', options.name);
    // console.log('Description:', options.description);
    const defaultConfig: Config = {
      name: str,
      entry: './src/index.ts',
      esbuildPlugins: [],
      port: 80,
      esbuildExternals: [],
      envs: {
        prod: {
          aws: {
            region: 'us-west-2',
            profile: 'quickgame',
          },
          env: {
            NODE_ENV: 'development',
          },
        },
      },
    };

    fs.writeFileSync('config.js', `module.exports = ${JSON.stringify(defaultConfig, null, 2)};`);
  });

async function buildProject(config: Config) {
  console.log('Building the project...');
  try {
    if (fs.existsSync('.sde')) {
      fs.rmSync('.sde', {recursive: true});
    }
    const result = await esbuild.build({
      entryPoints: [config.entry],
      outfile: './.sde/index.js',
      bundle: true,
      platform: 'node',
      target: 'es2022',
      external: config.esbuildExternals,
      sourcemap: true,
      plugins: config.esbuildPlugins,
    });
  } catch (e) {
    console.error(e);
    throw e;
  }
}

function getConfig() {
  return eval(fs.readFileSync('config.js', 'utf-8')) as Config;
}

program
  .command('deploy')
  .description('Deploy the project')
  .option('-l, --local', 'Run the docker instance local')
  .action(async (options) => {
    if (!fs.existsSync('config.js')) {
      console.error('Project does not exist');
      return;
    }
    const config = getConfig();
    await buildProject(config);

    if (!shell.which('docker')) {
      shell.echo('Sorry, this script requires docker');
      shell.exit(1);
      return;
    }
    if (!shell.which('aws')) {
      shell.echo('Sorry, this script requires aws');
      shell.exit(1);
      return;
    }
    // check if docker daemon is running
    if (shell.exec('docker info', {silent: true}).code !== 0) {
      shell.echo('Docker daemon is not running');
      shell.exit(1);
      return;
    }

    if (options.local) {
      // specify the dockerfile
      fs.writeFileSync(
        'Dockerfile',
        dockerTemplate
          .replace('{nodeVersion}', config.nodeVersion ? config.nodeVersion.toString() : '22')
          .replace('{port}', config.port.toString())
      );
      shell.exec(`docker build -t ${config.name} . && docker run -p ${config.port}:${config.port} ${config.name}`);
    } else {
      console.log('Deploying the project to aws...');
    }
  });

program
  .command('run')
  .description('Run the project locally')
  .action(async () => {
    if (!fs.existsSync('config.js')) {
      console.error('Project does not exist');
      return;
    }
    const config = getConfig();

    await buildProject(config);

    shell.exec(`node .sde/index.js`, {async: true});
  });
program.parse();

/*

// initialize a new project
//  - creates the config js

config.js
  - stores the project name
  - stores the entry point
  - links to any esbuild plugins
  - stores any docker funkiness
  - dev env
  - prod env
  - port to expose
  - aws
    - region
    - profile

commands
 - run local
   - runs esbuild
   - runs the dist with dev flags
   - nodemon
 - deploy
  - need to get aws accountid
  - login aws
   - aws ecr get-login-password  --profile quickgame --region us-west-2 | docker login --username AWS --password-stdin {accountid}.dkr.ecr.us-west-2.amazonaws.com
  - docker build -t {name} . && docker tag ${name}:latest {accountId}.dkr.ecr.us-west-2.amazonaws.com
  - docker push {accountid}.dkr.ecr.us-west-2.amazonaws.com/{name}
  - aws ecs update-service --profile {profile} --force-new-deployment --cluster localtunnel-cluster --service localtunnel
 */
