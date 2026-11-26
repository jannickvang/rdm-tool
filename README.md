# RDM Tool

An Electron desktop prototype for Art-Net RDM discovery and fixture patching. On first launch it starts in simulator mode with eight fixtures and two simulated nodes; these are illustrative, not emulations of specific vendor firmware.

## Run

Requires Node.js 22.12 or newer.

```sh
npm install
npm run dev
```

Select an IPv4 adapter in the toolbar to bind UDP port 6454 and use a real network. The last selected adapter or simulator mode is restored on startup. If an adapter is unavailable, an error is shown instead of connecting to a different network. The application sends ArtPoll to the adapter's subnet broadcast and the standard Art-Net broadcasts, and uses unicast for TOD and RDM requests. Make sure the firewall permits UDP 6454 and no other application owns the selected port.

If the selected adapter disappears or the Art-Net socket fails, the connection is stopped and retained nodes and fixtures are no longer shown as online; their actual status cannot be verified until reconnection. The adapter list refreshes every three seconds, and the app automatically retries the selected adapter when it is available. You can also use **Reconnect** or select another adapter. Reconnection rebuilds the discovered list.

**Network Nodes** groups ArtPollReply bindings by physical node and shows names, IP, MAC (when supplied), ports, protocols, universes, cached RDM device count and last-seen status. Click the name or IP column header to sort; click a node name to filter fixtures, or its IP address to open its web interface in the default browser. Click outside the window or press Escape to close it. Clear the node filter above the fixture table. Device counts include retained offline fixtures. The fixture table's universe filter accepts a protocol or universe value; sACN ports without a known universe show **Unknown** rather than an invented address.

For detected LumiNode/LumiCore devices the main process reads `/api/IO`, each DMX port's `artrdm_candidates`, `/api/rdm/{port}/connected_devices` and `/api/rdm/uid?port={port}` over HTTP on the selected interface. The API's physical port lists are combined with ArtRdm GETs, using the port's `rdm_universe` for RDM traffic, independently of its displayed sACN/Art-Net source. A fixture omitted from a successfully read port list is marked offline; when it reappears, a fresh RDM response is required before it is shown online. Failed or unavailable lists are not treated as empty. API data may be incomplete or cached; fixtures are online only after an RDM response. If multiple candidate sources differ, the active universe is shown as unknown. API errors are shown in Network Nodes and logged; password-protected APIs requiring non-default credentials are not yet supported. Raw RDM API responses appear in the main-process console.

For Luminex fixtures the application rechecks the port's RDM configuration and UID ownership over HTTP before each SET; if a shared universe makes ownership ambiguous or the API is unavailable, nothing is sent. The existing Art-Net discovery remains available for other nodes.

**Discover / Refresh** requests the existing table of devices; **Force full discovery** sends an ArtTodControl flush followed by an ArtTodRequest. The gateway performs discovery asynchronously and may initially return an empty TOD or TodNak; subsequent updates and background requests populate the list. Enable RDM on the gateway's output ports and allow time for its discovery. Art-Net packet diagnostics are written to the Electron main-process console (launch the app from a terminal), including raw ArtRdm packets, destination, Port-Address, transaction, UID, PID, invalid and unmatched replies, NACKs and timeouts. Timeout messages include counts of datagrams from the target node and malformed or unmatched ArtRdm packets; a datagram count can include unrelated node traffic. Universes are displayed as Net:Sub-Net:Universe.

Select fixtures and choose **Patch selected**. The wizard identifies the active fixture; Page Up/Down or Alt/Cmd + Left/Right navigate without changing its address or moving focus back to the address field. Enter queues a patch and immediately advances (except while a personality menu is open). Pending patches are shown in amber; only confirmed patches receive a checkmark, and failures are shown in red and reported even after the wizard closes. Identify changes are also queued in the background. The toolbar indicates pending RDM work, and changing the connection or clearing the list is disabled until it finishes. Keep the application running until the queue finishes. Address SETs wait up to 2.5 seconds for an acknowledgement. If it times out, a GET checks the actual address before retrying the SET once; if the address cannot be verified, the app reports that it may already have changed rather than retrying blindly. RDM packets remain serialized and spaced by at least 20 ms after the preceding response or timeout, so physical identify changes may lag behind the wizard. The next suggested address includes the current fixture footprint and optional gap. Closing the wizard queues identification off; failures are displayed.

Fixtures are sorted by label by default. Click a fixture row to select it, Shift-click to select a range in the current table order, or Cmd/Ctrl-click to toggle individual rows. Checkboxes remain available, including for offline rows. Labels and addresses are read-only in the table: right-click a row and choose **Edit label** to edit that one fixture, or use **Patch** to change addresses. Right-click a selected row to act on the selection, or another row to select it first. **Patch** requires all selected fixtures online. The **Set DMX Mode** submenu is offered only for online fixtures with matching manufacturer, model and complete mode lists. Batch mode changes stop on the first failure and report how many fixtures were changed.

Hover over or focus a fixture's warning icon for a plain-language explanation of overlapping DMX addresses or RDM communication problems. Communication warnings appear beside the online status; detailed errors remain in the main-process console.

**Identify off for all** attempts to turn off identify on every known fixture, regardless of the current selection or filter, and reports failures including offline fixtures. An identify SET can take effect even if its acknowledgement times out: the app verifies the actual state with a GET and retries a timed-out GET once. If verification fails, the state remains unverified and is marked in the table; use the row's identify button to attempt to switch it off.

The toolbar shows the 60-second background polling status. **Poll now** immediately starts the same discovery and fixture reachability checks without resetting the automatic schedule or sending a discovery flush. The button shows when a polling cycle is running. Network mode also sends an ArtPoll heartbeat every three seconds, as required by Art-Net. Discovery requests and fixture address checks run at low priority; an in-flight RDM request completes before operator SET/identify transactions, which take priority over subsequent background work. A fixture is retained and marked offline after two consecutive failed checks or two distinct TOD cycles omitting it; a successful RDM reply restores it. Nodes become offline after roughly two missed polling periods. Local address/personality changes show **Patched**, while a subsequently observed address change shows **Changed externally**. **Clear list** removes the cached nodes and fixtures; the next discovery or background poll rebuilds the list.

In simulator mode each row has **Sim offline/online** and **External +1** controls. They change the simulated device, not the table directly: use **Discover / Refresh** or wait for a background poll to observe the change. Two missed polls are needed to mark an offline fixture; one successful poll restores it. Clearing the list does not reset simulated device state.

```sh
npm test       # packet and simulator tests
npm run build  # type-check, build, and create an unpacked app for the host
npm run dist   # package for the host (.dmg on macOS, NSIS .exe on Windows)
```

Electron Builder supports `--mac --arm64`, `--mac --x64`, and `--win --x64`; platform-specific packaging, signing and notarization require the appropriate host tools and credentials. The build is unsigned by default.

## Prototype limitations

- Physical Luminex and ELC gateways and Windows builds have not been verified. Do not rely on this prototype for a live show without lab testing.
- The UI addresses only the root RDM device (sub-device 0). The packet encoder supports a sub-device field, but sub-device enumeration and control are not implemented.
- ArtRdm (0x8300) carries root-device requests and replies. ArtRdmSub (0x8400) is a separate compressed sub-device protocol and is not implemented.
- RDM ACK and NACK are handled; ACK_TIMER, queued messages and ACK_OVERFLOW are not yet supported and produce an explicit error. Some devices require these responses.
- The RDM controller UID uses a randomly generated device ID with the provisional `7FF0` manufacturer field. A production release needs a properly assigned ESTA manufacturer ID and a persistent unique controller UID.
- Offline entries are retained until **Clear list** or reconnection. Polling is serialized and a cycle can take longer than 60 seconds on large or unresponsive networks; overlapping cycles are skipped.
- Identify and SET commands can affect real lighting equipment. Use an isolated test network first. The simulator makes no network writes.

Art-Net packet layouts are based on the [Art-Net 4 specification](https://art-net.org.uk/downloads/art-net.pdf). RDM and Art-Net interoperability requires validation against the relevant standards and actual hardware.
