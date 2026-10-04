// Captured from real Artifacts in Task 0 (spike). Do not edit by hand.
export type PushFixture = {
  name: string;
  request: string; // base64 of the receive-pack request body
  response: string; // base64 of the receive-pack response body
  sideBand: boolean;
  expectCommands: { oldSha: string; newSha: string; ref: string }[];
  expectResults: { ref: string; ok: boolean }[];
};
export const pushFixtures: PushFixture[] = [
  {
    "name": "create-branch",
    "request": "MDA4NzAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAgYmU0OWFkY2NkMzAwNGU3YTgwYWM4ZGE2ZDQ0M2ZjZGMwY2M1NGNmMiByZWZzL2hlYWRzL2ZlYXR1cmUvYQAgcmVwb3J0LXN0YXR1cyBzaWRlLWJhbmQtNjRrMDAwMFBBQ0sAAAACAAAAA5wKeJx9yssNwjAMANB7pvACSLZjx42EUFfJxxUcSlGaSozPBrzzm8MdrEfOtWmNSpGqiXVOni0LoVNTNRRO2MOnDH9PiJE26ZmZlZtrQklLK52t57ZVw0XMmMVDuebzGHDC/Vy/DyDLRLLEZHBDRQzt2PfXnP6nhM3LvIZDCT+5/y4jqgN4nDM0MDAzMVFIZKiYIamUaK31O0GVRf/b3vaugzP9Wg0hkmkMPL8/dLT9WblSZnvwm3aTE/6nn+rMBwBS3hfNMnicS+QCAADOAGwNUVYEMCL63tWMctbiefuwT+heqA==",
    "response": "MDAzMwEwMDBldW5wYWNrIG9rCjAwMWNvayByZWZzL2hlYWRzL2ZlYXR1cmUvYQowMDAwMDAwMA==",
    "sideBand": true,
    "expectCommands": [
      {
        "oldSha": "0000000000000000000000000000000000000000",
        "newSha": "be49adccd3004e7a80ac8da6d443fcdc0cc54cf2",
        "ref": "refs/heads/feature/a"
      }
    ],
    "expectResults": [
      {
        "ref": "refs/heads/feature/a",
        "ok": true
      }
    ]
  },
  {
    "name": "update-main",
    "request": "MDA4MjMzMWY0ZDkyMjI1MmNlNTYwNDY4Y2FkMjdkOWNmYjcwODQ3NzIyNGUgZGQ1M2FlZTczMGE0YjdhNjAzOGQ0ZWQ4MjY2ZWM3YjhlYzBlMTQyZSByZWZzL2hlYWRzL21haW4AIHJlcG9ydC1zdGF0dXMgc2lkZS1iYW5kLTY0azAwMDBQQUNLAAAAAgAAAAOYCnicfc5LDgIhDADQPafgAiZtKS0kxngVPiXjYhzDYOLx9QTu3+KtaeZjDUojJVUoFYlHRM61iRXDrMgVxSxIcK8y7bl8CDi4ZyKK1CwKsKRWOmnPbVSFxKpEbK6813ZMf/rref/cPGpG5BQk+QtEANeOfX+sZX+IW9uv6L5PoS1mrQF4nDM0MDAzMVFIY2Ao5bvDfs0x9gz7OubAl5bVTErbdwEAeJQJlzJ4nDPmAgAAcgA+sW4OkuyTcLl7AQeB6AK2WkuEuUM=",
    "response": "MDAyZQEwMDBldW5wYWNrIG9rCjAwMTdvayByZWZzL2hlYWRzL21haW4KMDAwMDAwMDA=",
    "sideBand": true,
    "expectCommands": [
      {
        "oldSha": "331f4d922252ce560468cad27d9cfb708477224e",
        "newSha": "dd53aee730a4b7a6038d4ed8266ec7b8ec0e142e",
        "ref": "refs/heads/main"
      }
    ],
    "expectResults": [
      {
        "ref": "refs/heads/main",
        "ok": true
      }
    ]
  },
  {
    "name": "delete-branch",
    "request": "MDA4N2JlNDlhZGNjZDMwMDRlN2E4MGFjOGRhNmQ0NDNmY2RjMGNjNTRjZjIgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCByZWZzL2hlYWRzL2ZlYXR1cmUvYQAgcmVwb3J0LXN0YXR1cyBzaWRlLWJhbmQtNjRrMDAwMA==",
    "response": "MDAzMwEwMDBldW5wYWNrIG9rCjAwMWNvayByZWZzL2hlYWRzL2ZlYXR1cmUvYQowMDAwMDAwMA==",
    "sideBand": true,
    "expectCommands": [
      {
        "oldSha": "be49adccd3004e7a80ac8da6d443fcdc0cc54cf2",
        "newSha": "0000000000000000000000000000000000000000",
        "ref": "refs/heads/feature/a"
      }
    ],
    "expectResults": [
      {
        "ref": "refs/heads/feature/a",
        "ok": true
      }
    ]
  },
  {
    "name": "mixed",
    "request": "MDA4MzAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAgODllNmY5ZWU3NDU1MjY3ZjVkODQyMjI4YzE1ODZlNDExOTMyMGE2ZCByZWZzL2hlYWRzL25ldy1vawByZXBvcnQtc3RhdHVzIHNpZGUtYmFuZC02NGswMDY1MzMxZjRkOTIyMjUyY2U1NjA0NjhjYWQyN2Q5Y2ZiNzA4NDc3MjI0ZSA4OWU2ZjllZTc0NTUyNjdmNWQ4NDIyMjhjMTU4NmU0MTE5MzIwYTZkIHJlZnMvaGVhZHMvbWFpbjAwNjI4OWU2ZjllZTc0NTUyNjdmNWQ4NDIyMjhjMTU4NmU0MTE5MzIwYTZkIDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAgcmVmcy9oZWFkcy9jMDAwMFBBQ0sAAAACAAAAAAKdCII72KjqtRCtasdcgjz9PtMe",
    "response": "MDA5YgEwMDBldW5wYWNrIG9rCjAwMzRuZyByZWZzL2hlYWRzL25ldy1vayBhdG9taWMgdHJhbnNhY3Rpb24gYWJvcnRlZAowMDIxbmcgcmVmcy9oZWFkcy9tYWluIHN0YWxlIHJlZgowMDJmbmcgcmVmcy9oZWFkcy9jIGF0b21pYyB0cmFuc2FjdGlvbiBhYm9ydGVkCjAwMDAwMDAw",
    "sideBand": true,
    "expectCommands": [
      {
        "oldSha": "0000000000000000000000000000000000000000",
        "newSha": "89e6f9ee7455267f5d842228c1586e4119320a6d",
        "ref": "refs/heads/new-ok"
      },
      {
        "oldSha": "331f4d922252ce560468cad27d9cfb708477224e",
        "newSha": "89e6f9ee7455267f5d842228c1586e4119320a6d",
        "ref": "refs/heads/main"
      },
      {
        "oldSha": "89e6f9ee7455267f5d842228c1586e4119320a6d",
        "newSha": "0000000000000000000000000000000000000000",
        "ref": "refs/heads/c"
      }
    ],
    "expectResults": [
      {
        "ref": "refs/heads/new-ok",
        "ok": false
      },
      {
        "ref": "refs/heads/main",
        "ok": false
      },
      {
        "ref": "refs/heads/c",
        "ok": false
      }
    ]
  },
  {
    "name": "no-sideband",
    "request": "MDA3ODAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAgZGQ1M2FlZTczMGE0YjdhNjAzOGQ0ZWQ4MjY2ZWM3YjhlYzBlMTQyZSByZWZzL2hlYWRzL2ZlYXR1cmUvYgByZXBvcnQtc3RhdHVzMDAwMFBBQ0sAAAACAAAAAAKdCII72KjqtRCtasdcgjz9PtMe",
    "response": "MDAwZXVucGFjayBvawowMDFjb2sgcmVmcy9oZWFkcy9mZWF0dXJlL2IKMDAwMA==",
    "sideBand": false,
    "expectCommands": [
      {
        "oldSha": "0000000000000000000000000000000000000000",
        "newSha": "dd53aee730a4b7a6038d4ed8266ec7b8ec0e142e",
        "ref": "refs/heads/feature/b"
      }
    ],
    "expectResults": [
      {
        "ref": "refs/heads/feature/b",
        "ok": true
      }
    ]
  },
  {
    "name": "multi-ok",
    "request": "MDA4MzAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAgODllNmY5ZWU3NDU1MjY3ZjVkODQyMjI4YzE1ODZlNDExOTMyMGE2ZCByZWZzL2hlYWRzL25ldy1vawByZXBvcnQtc3RhdHVzIHNpZGUtYmFuZC02NGswMDYyODllNmY5ZWU3NDU1MjY3ZjVkODQyMjI4YzE1ODZlNDExOTMyMGE2ZCAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIHJlZnMvaGVhZHMvYzAwMDBQQUNLAAAAAgAAAAACnQiCO9io6rUQrWrHXII8/T7THg==",
    "response": "MDA0NAEwMDBldW5wYWNrIG9rCjAwMTlvayByZWZzL2hlYWRzL25ldy1vawowMDE0b2sgcmVmcy9oZWFkcy9jCjAwMDAwMDAw",
    "sideBand": true,
    "expectCommands": [
      {
        "oldSha": "0000000000000000000000000000000000000000",
        "newSha": "89e6f9ee7455267f5d842228c1586e4119320a6d",
        "ref": "refs/heads/new-ok"
      },
      {
        "oldSha": "89e6f9ee7455267f5d842228c1586e4119320a6d",
        "newSha": "0000000000000000000000000000000000000000",
        "ref": "refs/heads/c"
      }
    ],
    "expectResults": [
      {
        "ref": "refs/heads/new-ok",
        "ok": true
      },
      {
        "ref": "refs/heads/c",
        "ok": true
      }
    ]
  }
];
