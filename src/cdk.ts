import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ecr from '@aws-cdk/aws-ecr';
import * as ecs_patterns from '@aws-cdk/aws-ecs-patterns';
import * as route53 from '@aws-cdk/aws-route53';
import * as acm from '@aws-cdk/aws-certificatemanager';
import * as iam from '@aws-cdk/aws-iam';
import {FargateTaskDefinition} from '@aws-cdk/aws-ecs';
import {Construct, RemovalPolicy, StackProps} from '@aws-cdk/core';

export class DeployStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    {
      name,
      vpcId,
      hostedZoneID,
      zoneName,
      domainName,
      healthCheckRoute,
      cpu,
      memory,
      sslCertificateARN,
      step,
      props,
    }: {
      name: string;
      vpcId: string;
      hostedZoneID: string;
      healthCheckRoute: string;
      zoneName: string;
      domainName: string;
      cpu: number;
      memory: number;
      sslCertificateARN: string;
      step: 'setup' | 'deploy';
      props?: StackProps;
    }
  ) {
    super(scope, id, props);
    const vpc = ec2.Vpc.fromLookup(this, 'VPC', {
      vpcId: vpcId,
    });
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        // Add any other managed policies or inline policies as needed
      ],
    });
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Adding ECS DescribeServices permission to the task role
    taskRole.addToPolicy(
      new iam.PolicyStatement({
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
    const cluster = new ecs.Cluster(this, `${name}Cluster`, {
      vpc,
      clusterName: `${name}-cluster`,
    });

    // create acm cert
    const DNSZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      zoneName: zoneName,
      hostedZoneId: hostedZoneID,
    });
    // add wildcard CNAME
    new route53.CnameRecord(this, 'CnameRecordWildcard', {
      zone: DNSZone,
      recordName: '*',
      domainName: domainName,
    });
    const cert = acm.Certificate.fromCertificateArn(this, 'Cert', sslCertificateARN);

    // task definition
    let FgTask = new FargateTaskDefinition(this, 'LocaltunnelDefinition', {
      cpu: cpu,
      memoryLimitMiB: memory,
      executionRole: taskExecutionRole,
      taskRole: taskRole,
    });

    const repository = new ecr.Repository(this, `${name}-server`, {
      repositoryName: `${name}-server`,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    FgTask.addContainer('localtunnel', {
      image: ecs.ContainerImage.fromEcrRepository(repository),
      cpu: 128,
      entryPoint: ['node', 'init.mjs'],
      logging: new ecs.AwsLogDriver({
        streamPrefix: id + '-' + 'tunnel',
        logRetention: 1,
      }),
    }).addPortMappings({
      containerPort: 80,
    });

    const mySecurityGroup = new ec2.SecurityGroup(this, `${name}-sg`, {
      vpc,
      description: 'Allow TCP 1024-65536',
      allowAllOutbound: true,
    });
    if (step === 'setup') {
      // you cannot deploy the service without the repository
      // so we only create the repository in the setup step
      // and then we deploy the service in the deploy step
      return;
    }

    let localtunnelsvc = new ecs_patterns.ApplicationLoadBalancedFargateService(this, `${name}Service`, {
      cluster: cluster,
      cpu: 512,
      vpc,
      desiredCount: 1,
      taskDefinition: FgTask,
      memoryLimitMiB: 2048,
      publicLoadBalancer: true,
      certificate: cert,
      redirectHTTP: true,
      recordType: ecs_patterns.ApplicationLoadBalancedServiceRecordType.ALIAS,
      listenerPort: 443,
      domainName: domainName,
      domainZone: DNSZone,
      assignPublicIp: true,
      serviceName: name,
      securityGroups: [mySecurityGroup],
    });
    // set health route
    localtunnelsvc.targetGroup.configureHealthCheck({
      path: healthCheckRoute,
    });
  }
}
