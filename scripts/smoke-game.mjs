import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');
const serverPath = path.join(projectRoot, 'server.js');
const source = await fs.readFile(serverPath, 'utf8');
const harnessPath = path.join(projectRoot, `.server-harness-${process.pid}-${Date.now()}.mjs`);
const harnessSource = source
  .replace(/server\.listen\([\s\S]*?\n\}\);/, '')
  .concat('\nexport { makeRoom, makePlayer, getProblem, makePenaltyProblem, makeNegativeProblem, advancePlayer, isLosing };\n');

await fs.writeFile(harnessPath, harnessSource);
const { makeRoom, makePlayer, getProblem, makePenaltyProblem, makeNegativeProblem, advancePlayer, isLosing } = await import(pathToFileURL(harnessPath).href);

const room = makeRoom('smoke');
const player = makePlayer('p1', 'Ada', room);

for (let index = 0; index < 400; index += 1) {
  const generated = getProblem(room, index);
  const [left, operator, right] = generated.text.split(' ');
  const a = Number(left);
  const b = Number(right);

  if (operator === '+') {
    assert.ok(a >= 2 && a <= 100);
    assert.ok(b >= 2 && b <= 100);
    assert.equal(generated.answer, a + b);
  } else if (operator === '-') {
    assert.ok(a >= 4 && a <= 200);
    assert.ok(b >= 2 && b <= 100);
    assert.equal(generated.answer, a - b);
    assert.ok(generated.answer >= 2 && generated.answer <= 100);
  } else if (operator === '×') {
    assert.ok(a >= 2 && a <= 12);
    assert.ok(b >= 2 && b <= 100);
    assert.equal(generated.answer, a * b);
  } else if (operator === '÷') {
    assert.ok(b >= 2 && b <= 12);
    assert.equal(generated.answer, a / b);
    assert.ok(generated.answer >= 2 && generated.answer <= 100);
  } else {
    assert.fail(`Unknown operator ${operator}`);
  }
}

const penalty = makePenaltyProblem(room.rng);
const [penaltyLeft, , penaltyRight] = penalty.text.split(' ');
assert.ok(Number(penaltyLeft) >= 1000 && Number(penaltyLeft) <= 9999);
assert.ok(Number(penaltyRight) >= 1000 && Number(penaltyRight) <= 9999);
assert.equal(penalty.answer, Number(penaltyLeft) + Number(penaltyRight));
assert.equal(penalty.penalty, true);

const negative = makeNegativeProblem(room.rng);
const [negativeLeft, , negativeRight] = negative.text.split(' ');
assert.equal(negative.answer, Number(negativeLeft) - Number(negativeRight));
assert.ok(negative.answer < 0);
assert.equal(negative.challenge, true);

player.score = 7;
player.problemIndex = 7;
const returnProblem = getProblem(room, 7);
player.problem = penalty;
player.penaltyActive = true;
player.penaltyReturnProblem = returnProblem;
advancePlayer(room, player);
assert.equal(player.score, 7);
assert.equal(player.problemIndex, 7);
assert.equal(player.penaltyActive, false);
assert.equal(player.problem, returnProblem);
assert.equal(player.penaltyReturnProblem, null);

assert.equal(isLosing({ score: 3 }, { score: 4 }), true);
assert.equal(isLosing({ score: 4 }, { score: 4 }), false);

await fs.rm(harnessPath, { force: true });
console.log('game smoke checks passed');
