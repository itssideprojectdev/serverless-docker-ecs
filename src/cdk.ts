import {RemovalPolicy, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {ManagedPolicy, PolicyStatement, Role, ServicePrincipal} from 'aws-cdk-lib/aws-iam';
import {SecurityGroup, Vpc} from 'aws-cdk-lib/aws-ec2';
import {Certificate} from 'aws-cdk-lib/aws-certificatemanager';
import {AwsLogDriver, Cluster, ContainerImage, FargateTaskDefinition} from 'aws-cdk-lib/aws-ecs';
import {CnameRecord, HostedZone} from 'aws-cdk-lib/aws-route53';
import {Repository} from 'aws-cdk-lib/aws-ecr';
import {Bucket} from 'aws-cdk-lib/aws-s3';
import {CloudFrontWebDistribution, OriginAccessIdentity} from 'aws-cdk-lib/aws-cloudfront';
import {BucketDeployment, Source} from 'aws-cdk-lib/aws-s3-deployment';
import {
  ApplicationLoadBalancedFargateService,
  ApplicationLoadBalancedServiceRecordType,
} from 'aws-cdk-lib/aws-ecs-patterns';
import {Config} from './config';
import {OriginProtocolPolicy} from 'aws-cdk-lib/aws-cloudfront/lib/distribution';
import {CloudFrontAllowedMethods} from 'aws-cdk-lib/aws-cloudfront/lib/web-distribution';

export class DeployStack extends Stack {
  constructor(scope: Construct, id: string, config: Config, step: 'setup' | 'deploy', props?: StackProps) {
    super(scope, id, props);

    const name = config.name;
    const vpc = Vpc.fromLookup(this, 'VPC', {
      vpcId: config.aws.vpcId,
    });
    const taskExecutionRole = new Role(this, 'TaskExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        // Add any other managed policies or inline policies as needed
      ],
    });
    const taskRole = new Role(this, 'TaskRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Adding ECS DescribeServices permission to the task role
    taskRole.addToPolicy(
      new PolicyStatement({
        actions: [
          'ecs:DescribeServices',
          'ecs:DescribeTaskDefinition',
          'ecs:DescribeTasks',
          'ecs:ListTasks',
          'ecs:ListServices',
          'ec2:DescribeNetworkInterfaces',
        ],
        resources: ['*'],
      })
    );

    // create the ecs cluster
    const cluster = new Cluster(this, `${name}Cluster`, {
      vpc,
      clusterName: `${name}-cluster`,
    });

    // create acm cert
    const DNSZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      zoneName: config.aws.zoneName,
      hostedZoneId: config.aws.hostedZoneID,
    });
    // add wildcard CNAME
    new CnameRecord(this, 'CnameRecordWildcard', {
      zone: DNSZone,
      recordName: '*',
      domainName: config.aws.domainName,
    });
    const cert = Certificate.fromCertificateArn(this, 'Cert', config.aws.sslCertificateARN);

    // task definition
    let FgTask = new FargateTaskDefinition(this, `${name}Definition`, {
      cpu: config.aws.cpu,
      memoryLimitMiB: config.aws.memory,
      executionRole: taskExecutionRole,
      taskRole: taskRole,
    });

    const repository = new Repository(this, `${name}-server`, {
      repositoryName: `${name}-server`,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    FgTask.addContainer(name, {
      image: ContainerImage.fromEcrRepository(repository),
      cpu: 128,
      // entryPoint: ['node', 'index.js'],
      logging: new AwsLogDriver({
        streamPrefix: id + '-' + name,
        logRetention: 1,
      }),
    }).addPortMappings({
      containerPort: config.port,
    });

    const mySecurityGroup = new SecurityGroup(this, `${name}-sg`, {
      vpc,
      description: 'Allow TCP 1024-65536',
      allowAllOutbound: true,
    });

    const staticAssetsBucket = new Bucket(this, `${name}StaticAssets`, {
      bucketName: config.name + '-static-assets',
      publicReadAccess: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Create Origin Access Identity for CloudFront
    const originAccessIdentity = new OriginAccessIdentity(this, `${name}OAI`);
    staticAssetsBucket.grantRead(originAccessIdentity);

    // Create CloudFront distribution
    const distribution = new CloudFrontWebDistribution(this, `${name}Distribution`, {
      originConfigs: [
        {
          s3OriginSource: {
            s3BucketSource: staticAssetsBucket,
            originAccessIdentity,
          },
          behaviors: [{isDefaultBehavior: true}],
        },
      ],
      viewerCertificate: {
        aliases: [config.aws.domainName],
        props: {
          acmCertificateArn: config.aws.sslEastCertificateARN,
          sslSupportMethod: 'sni-only',
        },
      },
    });

    if (step === 'setup') {
      // you cannot deploy the service without the repository
      // so we only create the repository in the setup step
      // and then we deploy the service in the deploy step
      return;
    }

    let scv = new ApplicationLoadBalancedFargateService(this, `${name}Service`, {
      cluster: cluster,
      cpu: 512,
      desiredCount: config.aws.concurrentExecutions,
      taskDefinition: FgTask,
      memoryLimitMiB: 2048,
      publicLoadBalancer: true,
      certificate: cert,
      redirectHTTP: true,
      recordType: ApplicationLoadBalancedServiceRecordType.ALIAS,
      listenerPort: 443,
      domainName: config.aws.domainName,
      domainZone: DNSZone,
      assignPublicIp: true,
      serviceName: name,
      securityGroups: [mySecurityGroup],
    });
    // set health route
    scv.targetGroup.configureHealthCheck({
      path: config.aws.healthCheckRoute,
    });
  }
}
