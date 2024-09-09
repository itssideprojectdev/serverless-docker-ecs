#!/usr/bin/env node
import {S3Client, PutObjectCommand} from '@aws-sdk/client-s3';
import * as glob from 'glob';
import {Command} from 'commander';
import fs from 'node:fs';
import esbuild from 'esbuild';
import path from 'node:path';
import shell from 'shelljs';
import chokidar from 'chokidar';
import dockerTemplate from './dockerTemplate.txt';
import {ChildProcess} from 'node:child_process';
import * as os from 'node:os';
import {DeployStack} from './cdk';
import {AwsCdkCli, ICloudAssemblyDirectoryProducer, RequireApproval} from '@aws-cdk/cli-lib-alpha';
import {App} from 'aws-cdk-lib';
import {Config} from './config';

const getTempDirPath = () => {
  const tmp = os.tmpdir();
  return path.join(tmp, Math.random().toString(36));
};
const tempPath = getTempDirPath();
fs.mkdirSync(tempPath, {recursive: true});
const dockerfilePath = path.join(tempPath, 'Dockerfile');

const program = new Command();
program.version('0.0.1');
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
      build: {
        type: 'esbuild',
        entry: './src/index.ts',
        esbuildPlugins: [],
        esbuildExternals: [],
      },
      port: 80,
      nodeVersion: 22,
      aws: {
        sslEastCertificateARN: '',
        region: 'us-west-2',
        accountId: 'us-west-2',
        profile: '',
        concurrentExecutions: 3,
        cpu: 256,
        memory: 512,
        sslCertificateARN: '',
        vpcId: '',
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
    fs.mkdirSync('./.sde');
    if (config.build.type === 'esbuild') {
      const result = await esbuild.build({
        absWorkingDir: process.cwd(),
        entryPoints: [config.build.entry],
        outfile: './.sde/index.js',
        bundle: true,
        platform: 'node',
        target: 'es2022',
        external: config.build.esbuildExternals,
        sourcemap: true,
        plugins: config.build.esbuildPlugins,
      });
    } else if (config.build.type === 'nextjs') {
      shell.exec(`pnpm build`);
    }
    // fs.copyFileSync('./package.json', './.sde/package.json');
    fs.copyFileSync('./.env', './.sde/.env');
    console.log('Build complete');
  } catch (e) {
    console.error(e);
    throw e;
  }
}

function getConfig() {
  return require(require.resolve('./config', {paths: [process.cwd()]}));
  // return eval(fs.readFileSync('config.js', 'utf-8')) as Config;
}

function dockerBuild(config: Config) {
  shell.exec(`docker build -t ${config.name} . -f ${dockerfilePath}`);
}

function dockerRunLocal(config: Config) {
  console.log(`docker run -p ${config.port}:${config.port} ${config.name}`);
  const r = shell.exec(`docker run -p ${config.port}:${config.port} ${config.name}`);
  // log errors
  console.log(r.code);
  if (r.code !== 0) {
    console.error(r.stderr);
  }
}

function restartService(config: Config) {
  let s = `aws ecs update-service --profile ${config.aws.profile} --force-new-deployment --cluster ${
    config.name
  }-cluster --service ${config.name}`;

  shell.exec(s);
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

    const accountId = config.aws.accountId;
    shell.exec(
      `docker login --username AWS --password=${password} ${accountId}.dkr.ecr.${config.aws.region}.amazonaws.com`
    );
    dockerBuild(config);
    shell.exec(
      `docker tag ${config.name}:latest ${accountId}.dkr.ecr.${config.aws.region}.amazonaws.com/${config.name}-server`
    );
    shell.exec(`docker push ${accountId}.dkr.ecr.${config.aws.region}.amazonaws.com/${config.name}-server`);
    console.log('Service deployed');
    await new Promise((resolve) => setTimeout(resolve, 10000));
    console.log('Restarting the service...');
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
  .option('-f, --firstTime', 'if this is the first time deploying')
  .action(async (options) => {
    await setupAws(options.firstTime);
  });
program
  .command('destroy-aws')
  .description('Setup the aws resources')
  .action(async (options) => {
    // are you sure

    await destroyAWS();
  });

program
  .command('deploy-code')
  .description('Build and deploy static assets to S3')
  .action(async () => {
    if (!fs.existsSync('config.js')) {
      console.error('Project does not exist');
      return;
    }
    const config = getConfig();
    await buildProject(config);
    await deployToS3(config);
  });

async function deployToS3(config: Config) {
  console.log('Deploying static assets to S3...');
  const s3Client = new S3Client({
    region: config.aws.region,
  });

  const files = glob.sync('.sde/static/**/*', {nodir: true});

  for (const file of files) {
    const fileContent = fs.readFileSync(file);
    const key = file.replace('.sde/', '');

    await s3Client.send(
      new PutObjectCommand({
        Bucket: config.name + '-static-assets',
        Key: key,
        Body: fileContent,
        ContentType: getContentType(file),
      })
    );
  }

  console.log('Static assets deployed to S3');
}

function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html';
    case '.css':
      return 'text/css';
    case '.js':
      return 'application/javascript';
    case '.json':
      return 'application/json';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

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
      childProcess = shell.exec(`node .sde/index.js`, {async: true});
      // childProcess.kill('SIGTERM');
      building = false;
    });
  });

async function setupAws(firstTime: boolean) {
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

  const producer = new MyProducer();
  producer.config = config;

  let cli = AwsCdkCli.fromCloudAssemblyDirectoryProducer(producer);

  if (!firstTime) {
    await cli.synth();
    await cli.bootstrap({
      profile: config.aws.profile,
      stacks: [`aws://${config.aws.accountId}/${config.aws.region}`],
    });
    producer.step = 'deploy';
    await cli.deploy({requireApproval: RequireApproval.NEVER, profile: config.aws.profile});
  } else {
    await cli.synth();
    //

    await cli.bootstrap({
      profile: config.aws.profile,
      stacks: [`aws://${config.aws.accountId}/${config.aws.region}`],
    });

    await cli.synth();

    await cli.deploy({requireApproval: RequireApproval.NEVER, profile: config.aws.profile});

    await deployDocker({local: false});
  }
}

async function destroyAWS() {
  if (!fs.existsSync('config.js')) {
    console.error('Project does not exist');
    return;
  }

  const config = getConfig();

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

  const producer = new MyProducer();
  producer.config = config;

  let cli = AwsCdkCli.fromCloudAssemblyDirectoryProducer(producer);

  await cli.destroy({
    profile: config.aws.profile,
  });
}

program.parse();
/*

process.chdir('C:\\code\\sde-test1');
setupAws()
  .then(() => {
    console.log('done');
  })
  .catch((e) => {
    console.error(e);
  });
*/

/*

need to run the cdk stuff to set up the cluster
need to set up the ecr repository

*/

class MyProducer implements ICloudAssemblyDirectoryProducer {
  step: 'setup' | 'deploy' = 'setup';
  config?: Config;
  async produce(context: Record<string, any>) {
    if (!this.config) {
      throw new Error('Config not set');
    }
    let app = new App({context, outdir: process.cwd() + '/.cdk.out'});
    const config = this.config;
    new DeployStack(app, config.name, config, this.step, {
      env: {
        account: config.aws.accountId,
        region: config.aws.region,
      },
    });

    return app.synth({}).directory;
  }
}
