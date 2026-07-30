const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const missing = [null, undefined, '', ' ', '-', '--', '暂无数据', 'null', 'None', 'NaN', 'N/A', false, true, [], {}];

function loadOk(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const match = source.match(/const ok = value => \{([\s\S]*?)\n\s*\};/);
  assert.ok(match, `${file} should define the numeric validity guard`);
  return new Function('value', match[1]);
}

for (const file of ['app.js', 'realtime.js']) {
  const ok = loadOk(file);
  for (const value of missing) {
    assert.equal(ok(value), false, `${file} must reject ${JSON.stringify(value)}`);
  }
  assert.equal(ok(0), true, `${file} must preserve a real numeric zero`);
  assert.equal(ok('0'), true, `${file} must preserve a numeric string zero`);
  assert.equal(ok(1.23), true);
}

const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
assert.match(appSource, /function primaryFund\(\)\{ return byCode\(primaryCode\(\)\) \|\| null; \}/);
assert.doesNotMatch(appSource, /function primaryFund\(\)[^{]*\{[^}]*bestByScore/);

const realtimeSource = fs.readFileSync(path.join(root, 'realtime.js'), 'utf8');
assert.match(realtimeSource, /const row = rows\.find\(item => String\(item\.code\) === String\(primary\)\);/);
assert.match(realtimeSource, /const displayable = row && ok\(row\.premium\) && \['realtime', 'delayed', 'today'\]\.includes\(row\.freshness\);/);
assert.match(realtimeSource, /\[row\]\.filter\(item => item && ok\(item\.premium\)\)\.forEach/);

console.log('frontend null handling tests passed');
