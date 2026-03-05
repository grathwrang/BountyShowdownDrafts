// ── ADMIN PASSWORD HASH GENERATOR ─────────────────────────────────
// Run this once locally to generate your bcrypt hash:
//
//   node generate-hash.js
//
// Then copy the output hash into Railway as an environment variable:
//   ADMIN_PASSWORD_HASH = <the hash>
//
// The plain text password never needs to go anywhere else.
// To change your password, just run this script again with a new password.

const bcrypt = require('bcryptjs');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Enter your admin password: ', async (password) => {
  if (!password.trim()) {
    console.error('Password cannot be empty.');
    process.exit(1);
  }

  console.log('\nGenerating hash (this takes a moment — that is bcrypt working)...');
  const hash = await bcrypt.hash(password, 12);

  console.log('\n✓ Your bcrypt hash:\n');
  console.log(hash);
  console.log('\nAdd this to Railway environment variables as:');
  console.log('  ADMIN_PASSWORD_HASH =', hash);
  console.log('\nDo not store your plain text password anywhere.');
  rl.close();
});
