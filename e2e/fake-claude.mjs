#!/usr/bin/env node
// Stand-in for the `claude` CLI in e2e runs (QUORUM_CLAUDE_BINARY). The real CLI also honours credentials a host
// provides outside the environment (token files, managed settings), so the Settings spec would depend on the machine
// it runs on. This one always answers "not signed in" and never opens a sign-in.
const [command, subcommand] = process.argv.slice(2);

if (command === 'auth' && subcommand === 'status') {
  process.stdout.write(`${JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }, null, 2)}\n`);
  process.exit(1);
}

process.stderr.write(`fake-claude: "${process.argv.slice(2).join(' ')}" is not supported in e2e runs\n`);
process.exit(2);
