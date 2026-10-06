import assert from "node:assert/strict";
import { test } from "node:test";
import { releasePackages } from "./release-packages.mjs";

const head = "current-revision";
const channel = { name: "@anvia/channel", version: "0.4.0" };
const agent = { name: "@anvia/channel-agent", version: "0.4.1" };

function fixture() {
  const published = new Map([[channel.name, { gitHead: "previous-revision" }]]);
  const tags = new Map([["v0.4.0", "previous-revision"]]);
  const releases = new Set();
  let publications = 0;
  return {
    published,
    tags,
    releases,
    publications: () => publications,
    operations: {
      published: async (pkg) => published.get(pkg.name) ?? null,
      tagCommit: async (tag) => tags.get(tag) ?? null,
      publish: async () => {
        publications++;
        published.set(agent.name, { gitHead: head });
      },
      pushTag: async (tag, revision) => {
        tags.set(tag, revision);
      },
      releaseExists: async (tag) => releases.has(tag),
      createRelease: async (tag) => {
        releases.add(tag);
      },
    },
  };
}

test("an agent-only patch gets its own tag and does not retag the channel", async () => {
  const fake = fixture();
  await releasePackages([channel, agent], head, fake.operations);
  assert.equal(fake.publications(), 1);
  assert.deepEqual(
    [...fake.tags],
    [
      ["v0.4.0", "previous-revision"],
      ["@anvia/channel-agent@0.4.1", head],
    ],
  );
  assert.deepEqual([...fake.releases], ["@anvia/channel-agent@0.4.1"]);
});

test("a retry after publication skips npm and completes missing tags/releases", async () => {
  const fake = fixture();
  fake.published.set(agent.name, { gitHead: head });
  await releasePackages([channel, agent], head, fake.operations);
  await releasePackages([channel, agent], head, fake.operations);
  assert.equal(fake.publications(), 0);
  assert.equal(fake.tags.get("@anvia/channel-agent@0.4.1"), head);
  assert.equal(fake.releases.size, 1);
});

test("a retry recovers after a tag push but before the GitHub release", async () => {
  const fake = fixture();
  const createRelease = fake.operations.createRelease;
  fake.operations.createRelease = async () => {
    throw new Error("GitHub unavailable");
  };
  await assert.rejects(
    releasePackages([channel, agent], head, fake.operations),
    /GitHub unavailable/,
  );
  fake.operations.createRelease = createRelease;
  await releasePackages([channel, agent], head, fake.operations);
  assert.equal(fake.publications(), 1);
  assert.equal(fake.releases.size, 1);
});

test("preflight rejects a conflicting target tag before publishing anything", async () => {
  const fake = fixture();
  fake.tags.set("@anvia/channel-agent@0.4.1", "wrong-revision");
  await assert.rejects(
    releasePackages([channel, agent], head, fake.operations),
    /different commit/,
  );
  assert.equal(fake.publications(), 0);
});

test("a partial npm failure is recoverable without republishing accepted versions", async () => {
  const fake = fixture();
  fake.operations.publish = async () => {
    fake.published.set(agent.name, { gitHead: head });
    throw new Error("publish process interrupted");
  };
  await assert.rejects(releasePackages([channel, agent], head, fake.operations), /interrupted/);
  fake.operations.publish = async () => {
    assert.fail("must not republish");
  };
  await releasePackages([channel, agent], head, fake.operations);
  assert.equal(fake.releases.size, 1);
});

test("registry errors stop preflight and private packages are ignored", async () => {
  const fake = fixture();
  fake.operations.published = async () => {
    throw new Error("registry unavailable");
  };
  await releasePackages([{ ...agent, private: true }], head, fake.operations);
  await assert.rejects(releasePackages([agent], head, fake.operations), /registry unavailable/);
  assert.equal(fake.publications(), 0);
});

test("missing publication metadata stops tagging rather than implying success", async () => {
  const fake = fixture();
  fake.operations.publish = async () => undefined;
  await assert.rejects(releasePackages([agent], head, fake.operations), /not visible on npm/);
  assert.equal(fake.tags.has("@anvia/channel-agent@0.4.1"), false);
});

test("historical package tags are preserved and checked against npm gitHead", async () => {
  const fake = fixture();
  fake.tags.set("@anvia/channel@0.4.0", "previous-revision");
  await releasePackages([channel], head, fake.operations);
  assert.equal(fake.tags.get("@anvia/channel@0.4.0"), "previous-revision");
  fake.tags.set("@anvia/channel@0.4.0", "wrong-revision");
  await assert.rejects(releasePackages([channel], head, fake.operations), /published revision/);
});

test("publications without gitHead are not attributed to the current revision", async () => {
  const fake = fixture();
  fake.published.set(agent.name, {});
  const plan = await releasePackages([agent], head, fake.operations);
  assert.deepEqual(plan, []);
  assert.equal(fake.publications(), 0);
  assert.equal(fake.tags.has("@anvia/channel-agent@0.4.1"), false);
});

test("a mixed partial npm success retries only missing versions and tags both packages", async () => {
  const fake = fixture();
  const discord = { name: "@anvia/discord", version: "0.3.1" };
  fake.operations.publish = async () => {
    fake.published.set(agent.name, { gitHead: head });
    throw new Error("interrupted before Discord");
  };
  await assert.rejects(releasePackages([agent, discord], head, fake.operations), /interrupted/);
  fake.operations.publish = async () => {
    assert.equal(fake.published.get(agent.name)?.gitHead, head);
    assert.equal(fake.published.has(discord.name), false);
    fake.published.set(discord.name, { gitHead: head });
  };
  await releasePackages([agent, discord], head, fake.operations);
  assert.equal(fake.tags.get("@anvia/channel-agent@0.4.1"), head);
  assert.equal(fake.tags.get("@anvia/discord@0.3.1"), head);
  assert.equal(fake.releases.size, 2);
});

test("the recorded plan recovers mixed partial publication without npm gitHead", async () => {
  const fake = fixture();
  const discord = { name: "@anvia/discord", version: "0.3.1" };
  const recorded = { head, packages: [agent, discord] };
  fake.published.set(agent.name, {});
  fake.operations.publish = async () => {
    fake.published.set(discord.name, {});
  };
  await releasePackages([channel, agent, discord], head, fake.operations, recorded);
  assert.equal(fake.tags.get("@anvia/channel-agent@0.4.1"), head);
  assert.equal(fake.tags.get("@anvia/discord@0.3.1"), head);
  assert.equal(fake.tags.has("@anvia/channel@0.4.0"), false);
  fake.operations.publish = async () => {
    assert.fail("must not republish");
  };
  await releasePackages([channel, agent, discord], head, fake.operations, recorded);
  assert.equal(fake.releases.size, 2);
});

test("a recorded plan must match the dispatch revision and public manifests", async () => {
  const fake = fixture();
  for (const recorded of [
    { head: "wrong", packages: [agent] },
    { head, packages: [{ ...agent, version: "9.9.9" }] },
    { head, packages: [{ name: "unknown", version: "1" }] },
  ]) {
    await assert.rejects(
      releasePackages([agent], head, fake.operations, recorded),
      /does not match/,
    );
  }
  assert.equal(fake.publications(), 0);
});
