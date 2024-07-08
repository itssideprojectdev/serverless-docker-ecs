#!/usr/bin/env node
import {Command} from 'commander';
import fs from 'node:fs';
import esbuild from 'esbuild';
import path from 'node:path';
import shell from 'shelljs';
import chokidar from 'chokidar';
import dockerTemplate from './dockerTemplate.txt';
import {ChildProcess} from 'node:child_process';
import * as os from 'node:os';
import * as cdk from '@aws-cdk/core';
import {DeployStack} from './cdk';

const getTempDirPath = () => {
  const tmp = os.tmpdir();
  return path.join(tmp, Math.random().toString(36));
};
const tempPath = getTempDirPath();
fs.mkdirSync(tempPath, {recursive: true});
const dockerfilePath = path.join(tempPath, 'Dockerfile');

const program = new Command();
program.version('0.0.1');
type Config = {
  aws: {
    cpu: number;
    memory: number;
    sslCertificateARN: string;
    vpcID: string;
    healthCheckRoute: string;
    hostedZoneID: string;
    zoneName: string;
    domainName: string;
    profile: string;
    region: string;
    accountId: string;
  };
  entry: string;
  envs: {
    [key: string]: {
      env: {NODE_ENV: string};
    };
  };
  esbuildExternals: Array<string>;
  esbuildPlugins: Array<any>;
  name: string;
  nodeVersion: number;
  port: number;
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
      aws: {
        region: 'us-west-2',
        accountId: 'us-west-2',
        profile: '',
        cpu: 256,
        memory: 512,
        sslCertificateARN: '',
        vpcID: '',
        healthCheckRoute: '/',
        hostedZoneID: '',
        zoneName: '',
        domainName: '',
      },
      envs: {
        prod: {
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
  shell.exec(`docker build -t ${config.name} . -f ${dockerfilePath}`);
}

function dockerRunLocal(config: Config) {
  shell.exec(`docker run -p ${config.port}:${config.port} ${config.name}`);
}

function restartService(config: Config) {
  shell.exec(
    `aws ecs update-service --profile ${config.aws.profile} --force-new-deployment --cluster ${
      config.name
    }-cluster --service ${config.name}`
  );
}

async function deployDocker(options: {local: boolean}) {
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
    dockerfilePath,
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
      .exec(`aws ecr get-login-password  --profile ${config.aws.profile} --region ${config.aws.region}`, {
        silent: true,
      })
      .stdout.trim();

    // get aws account id
    const accountId = shell
      .exec('aws sts get-caller-identity --query "Account" --output text', {silent: true})
      .stdout.trim();
    shell.exec(
      `docker login --username AWS --password=${password} ${accountId}.dkr.ecr.${config.aws.region}.amazonaws.com`
    );
    dockerBuild(config);
    shell.exec(
      `docker tag ${config.name}:latest ${accountId}.dkr.ecr.${config.aws.region}.amazonaws.com/${config.name}`
    );
    shell.exec(`docker push ${accountId}.dkr.ecr.${config.aws.region}.amazonaws.com/${config.name}`);

    restartService(config);
  }
}

program
  .command('deploy')
  .description('Deploy the project')
  .option('-l, --local', 'Run the docker instance local')
  .action(async (options) => {
    await deployDocker(options);
  });

program
  .command('setup-aws')
  .description('Setup the aws resources')
  .action(async (options) => {
    if (!fs.existsSync('config.js')) {
      console.error('Project does not exist');
      return;
    }

    const config = getConfig();
    await buildProject(config);

    if (!shell.which('docker')) {
      shell.echo('Sorry, this script requires docker, use https://docs.docker.com/get-docker/');
      shell.exit(1);
      return;
    }
    if (!shell.which('aws')) {
      shell.echo('Sorry, this script requires aws, use npm install -g aws-cli');
      shell.exit(1);
      return;
    }
    if (!shell.which('cdk')) {
      shell.echo('Sorry, this script requires cdk, use npm install -g aws-cdk');
      shell.exit(1);
      return;
    }

    // use aws profile for cdk
    process.env.AWS_PROFILE = config.aws.profile;
    process.env.AWS_REGION = config.aws.region;
    // bootstrap
    shell.exec(`cdk bootstrap --profile ${config.aws.profile} aws://${config.aws.accountId}/${config.aws.region}`);

    let app = new cdk.App({
      outdir: process.cwd() + '/.cdk.out',
    });

    new DeployStack(app, config.name, {
      name: config.name,
      domainName: config.aws.domainName,
      zoneName: config.aws.zoneName,
      hostedZoneID: config.aws.hostedZoneID,
      healthCheckRoute: config.aws.healthCheckRoute,
      vpcId: config.aws.vpcID,
      sslCertificateARN: config.aws.sslCertificateARN,
      memory: config.aws.memory,
      cpu: config.aws.cpu,
      step: 'setup',
      props: {
        env: {
          account: config.aws.accountId,
          region: config.aws.region,
        },
      },
    });

    const assembly = app.synth({validateOnSynthesis: true});

    // Get the directory where the cloud assembly is located
    const cloudAssemblyDirectory = assembly.directory;
    console.log('Cloud assembly directory:', cloudAssemblyDirectory);
    // Run the CDK CLI deploy command
    const deployCommand = `cdk deploy --profile ${config.aws.profile} --require-approval never --app ${cloudAssemblyDirectory}`;

    console.log('Deploying the stack...');
    shell.exec(deployCommand, {silent: false});

    return;
    await deployDocker({local: false});

    app = new cdk.App({outdir: process.cwd() + '/.cdk.out'});
    new DeployStack(app, config.name, {
      name: config.name,
      domainName: config.aws.domainName,
      zoneName: config.aws.zoneName,
      hostedZoneID: config.aws.hostedZoneID,
      healthCheckRoute: config.aws.healthCheckRoute,
      vpcId: config.aws.vpcID,
      sslCertificateARN: config.aws.sslCertificateARN,
      memory: config.aws.memory,
      cpu: config.aws.cpu,
      step: 'deploy',
      props: {
        env: {
          account: config.aws.accountId,
          region: config.aws.region,
        },
      },
    });

    app.synth();
    shell.exec(deployCommand, {silent: false});
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
