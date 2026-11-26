# Contributing

Issues and pull requests are welcome. Describe the problem or proposed change
before starting substantial work, and avoid including credentials, private
network details or device identifiers in reports.

Use Node.js 22.12 or newer:

```sh
npm ci
npm test
npx tsc --noEmit
npx vite build
```

Add focused tests for behavior changes. Test in simulator mode first; RDM SET,
identify and discovery flush commands can affect connected lighting equipment.
Use an isolated test network before testing real hardware. Include the node,
firmware and test results in hardware-related reports, without private data.

By submitting a contribution, you agree to license it under the project's
[MIT license](LICENSE). Only submit material you have the right to contribute.
