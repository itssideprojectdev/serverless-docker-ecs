#!/usr/bin/env node
import {Command} from 'commander';
import fs from 'node:fs';
import esbuild from 'esbuild';
import shell from 'shelljs';
import chokidar from 'chokidar';
import dockerTemplate from './dockerTemplate.txt';
import {ChildProcess} from 'node:child_process';

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
      nodeVersion: 22,
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
    console.log('Build complete');
  } catch (e) {
    console.error(e);
    throw e;
  }
}

function getConfig() {
  return eval(fs.readFileSync('config.js', 'utf-8')) as Config;
}

function dockerBuild(config: Config) {
  shell.exec(`docker build -t ${config.name} .`);
}

function dockerRunLocal(config: Config) {
  shell.exec(`docker run -p ${config.port}:${config.port} ${config.name}`);
}

function restartService(config: Config) {
  shell.exec(
    `aws ecs update-service --profile ${config.envs.prod.aws.profile} --force-new-deployment --cluster ${
      config.name
    }-cluster --service ${config.name}`
  );
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

    fs.writeFileSync(
      'Dockerfile',
      dockerTemplate
        .replace('{nodeVersion}', config.nodeVersion ? config.nodeVersion.toString() : '22')
        .replace('{port}', config.port.toString())
    );

    if (options.local) {
      console.log('Deploying the project locally...');
      dockerBuild(config);
      dockerRunLocal(config);
    } else {
      console.log('Deploying the project to aws...');
      const password = shell
        .exec(
          `aws ecr get-login-password  --profile ${config.envs.prod.aws.profile} --region ${config.envs.prod.aws.region}`,
          {silent: true}
        )
        .stdout.trim();

      // get aws account id
      const accountId = shell
        .exec('aws sts get-caller-identity --query "Account" --output text', {silent: true})
        .stdout.trim();
      shell.exec(
        `docker login --username AWS --password=${password} ${accountId}.dkr.ecr.${config.envs.prod.aws.region}.amazonaws.com`
      );
      dockerBuild(config);
      shell.exec(
        `docker tag ${config.name}:latest ${accountId}.dkr.ecr.${config.envs.prod.aws.region}.amazonaws.com/${config.name}`
      );
      shell.exec(`docker push ${accountId}.dkr.ecr.${config.envs.prod.aws.region}.amazonaws.com/${config.name}`);

      restartService(config);
    }
  });

program
  .command('run')
  .description('Run the project locally')
  .option('-w, --watch', 'Watch the project for changes')
  .action(async () => {
    if (!fs.existsSync('config.js')) {
      console.error('Project does not exist');
      return;
    }
    let childProcess: ChildProcess | undefined = undefined;
    const config = getConfig();
    let building = false;
    chokidar.watch('./src').on('all', async () => {
      if (building) {
        return;
      }
      if (childProcess) {
        console.log('killing');
        childProcess.kill('SIGTERM'); // not working
      }
      building = true;
      await buildProject(config);
      console.log('HERE');
      childProcess = shell.exec(`node .sde/index.js`, {async: true});

      building = false;
    });
  });
program.parse();

/*

need to run the cdk stuff to set up the cluster
need to set up the ecr repository




*/
