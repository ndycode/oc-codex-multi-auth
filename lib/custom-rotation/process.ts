import { spawn, type ChildProcess } from "node:child_process";
import { win32 } from "node:path";

/** Ordinary descendants only; trusted policies can deliberately escape the tree. */
export function terminateRotationTree(child: ChildProcess): Promise<void> {
	if (!child.pid) return Promise.resolve();
	if (process.platform !== "win32") {
		try { process.kill(-child.pid, "SIGKILL"); }
		catch (cause) {
			if (cause instanceof Error && "code" in cause && cause.code === "EPERM") child.kill("SIGKILL");
			// Teardown is best-effort; host settlement must also survive kill failures.
		}
		return Promise.resolve();
	}
	// Never target a recycled Windows PID after an explicit policy process.exit().
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	let helper: ChildProcess;
	try {
		helper = spawn(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
			["/PID", String(child.pid), "/T", "/F"], { env: {}, stdio: "ignore", windowsHide: true });
	} catch (cause) {
		if (cause instanceof Error) child.kill("SIGKILL");
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		let done = false;
		const finish = (): void => {
			if (done) return;
			done = true;
			clearTimeout(timeout);
			helper.unref();
			child.kill("SIGKILL");
			resolve();
		};
		const timeout = setTimeout(() => { helper.kill("SIGKILL"); finish(); }, 200);
		helper.once("error", finish);
		helper.once("close", finish);
	});
}
