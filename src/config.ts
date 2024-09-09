export type Config = {
  aws: {
    cpu: number;
    memory: number;
    sslCertificateARN: string;
    sslEastCertificateARN: string;
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
  build:
    | {
        type: 'esbuild';
        entry: string;
        esbuildExternals: Array<string>;
        esbuildPlugins: Array<any>;
      }
    | {
        type: 'nextjs';
      };
  envs: {
    [key: string]: {
      env: {NODE_ENV: string};
    };
  };
  name: string;
  nodeVersion: number;
  port: number;
};
