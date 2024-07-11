export type Config = {
  aws: {
    cpu: number;
    memory: number;
    sslCertificateARN: string;
    vpcId: string;
    healthCheckRoute: string;
    hostedZoneID: string;
    zoneName: string;
    domainName: string;
    concurrentExecutions: number;
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
