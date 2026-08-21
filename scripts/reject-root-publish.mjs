if (process.env.GROK_WEB_ALLOW_ROOT_PUBLISH === "1") {
  process.exit(0);
}

console.error(
  "Do not npm publish from the repository root. Run `npm run pack:tanstack` and publish the staged tarball.",
);
process.exit(1);
