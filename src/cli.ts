#!/usr/bin/env node
import {Command} from 'commander';
const program = new Command();
program.version('0.0.1');
program
  .command('create')
  .description('Create a new project')
  .argument('<string>', 'string to split')
  .option('-n, --name <name>', 'Name of the project')
  .option('-d, --description <description>', 'Description of the project')
  .action((str, options) => {
    console.log('Creating a new project...');
    console.log('String:', str);
    console.log('Name:', options.name);
    console.log('Description:', options.description);
  });

program
  .command('deploy')
  .description('Deploy the project')
  .action(() => {
    console.log('Deploying the project...');
  });
program.parse();

console.log('Hello, world!', program.opts());
