export function renderOAuthSuccessHtml(styleNonce: string): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta name="color-scheme" content="dark">
	<title>OpenCode - Authentication complete</title>
	<style nonce="${styleNonce}">
		:root {
			color-scheme: dark;
			font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
			font-synthesis: none;
		}

		* {
			box-sizing: border-box;
		}

		body {
			min-width: 320px;
			min-height: 100vh;
			margin: 0;
			display: grid;
			place-items: center;
			padding: 32px 20px;
			background:
				radial-gradient(circle at 50% 0%, rgba(42, 195, 126, 0.12), transparent 38rem),
				#080b0a;
			color: #f2f5f3;
		}

		main {
			width: min(100%, 540px);
		}

		.brand {
			display: flex;
			margin: 0 0 24px 0;
			justify-content: center;
		}

		.brand svg {
			height: 22px;
			width: auto;
		}

		.card {
			position: relative;
			overflow: hidden;
			padding: 44px;
			border: 1px solid #26312c;
			border-radius: 20px;
			background: linear-gradient(145deg, rgba(22, 28, 25, 0.98), rgba(13, 17, 15, 0.98));
			box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
		}

		.card::before {
			content: "";
			position: absolute;
			inset: 0 0 auto;
			height: 1px;
			background: linear-gradient(90deg, transparent, rgba(86, 224, 157, 0.7), transparent);
		}

		.success-icon {
			width: 58px;
			height: 58px;
			display: grid;
			place-items: center;
			margin-bottom: 28px;
			border: 1px solid rgba(86, 224, 157, 0.45);
			border-radius: 16px;
			background: rgba(42, 195, 126, 0.1);
			color: #56e09d;
			box-shadow: inset 0 0 28px rgba(42, 195, 126, 0.08);
		}

		.success-icon svg {
			width: 28px;
			height: 28px;
		}

		h1 {
			margin: 0;
			font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			font-size: clamp(28px, 6vw, 38px);
			font-weight: 650;
			letter-spacing: -0.035em;
			line-height: 1.12;
		}

		.lead {
			margin: 16px 0 0;
			color: #aeb8b3;
			font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			font-size: 17px;
			line-height: 1.6;
		}

		.status {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-top: 30px;
			padding: 15px 16px;
			border: 1px solid #29362f;
			border-radius: 12px;
			background: #0b100d;
			color: #c9d2cd;
			font-size: 13px;
			line-height: 1.5;
		}

		.status-dot {
			width: 8px;
			height: 8px;
			flex: 0 0 auto;
			border-radius: 50%;
			background: #56e09d;
			box-shadow: 0 0 0 4px rgba(86, 224, 157, 0.1);
		}

		.next-step {
			margin: 24px 0 0;
			color: #7f8c85;
			font-size: 13px;
			line-height: 1.6;
		}

		.next-step strong {
			color: #b9c3be;
			font-weight: 600;
		}

		@media (max-width: 520px) {
			body {
				padding: 24px 16px;
			}

			.card {
				padding: 32px 24px;
				border-radius: 16px;
			}

			.success-icon {
				width: 52px;
				height: 52px;
				margin-bottom: 24px;
			}
		}

		@media (prefers-reduced-motion: reduce) {
			*, *::before, *::after {
				scroll-behavior: auto !important;
				animation-duration: 0.01ms !important;
				animation-iteration-count: 1 !important;
			}
		}
	</style>
</head>
<body>
	<main>
		<div class="brand" aria-label="OpenCode">
			<svg width="234" height="42" viewBox="0 0 234 42" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
				<path d="M18 30H6V18H18V30Z" fill="#4B4646"/>
				<path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="#B7B1B1"/>
				<path d="M48 30H36V18H48V30Z" fill="#4B4646"/>
				<path d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z" fill="#B7B1B1"/>
				<path d="M84 24V30H66V24H84Z" fill="#4B4646"/>
				<path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" fill="#B7B1B1"/>
				<path d="M108 36H96V18H108V36Z" fill="#4B4646"/>
				<path d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z" fill="#B7B1B1"/>
				<path d="M144 30H126V18H144V30Z" fill="#4B4646"/>
				<path d="M144 12H126V30H144V36H120V6H144V12Z" fill="#F1ECEC"/>
				<path d="M168 30H156V18H168V30Z" fill="#4B4646"/>
				<path d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" fill="#F1ECEC"/>
				<path d="M198 30H186V18H198V30Z" fill="#4B4646"/>
				<path d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z" fill="#F1ECEC"/>
				<path d="M234 24V30H216V24H234Z" fill="#4B4646"/>
				<path d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z" fill="#F1ECEC"/>
			</svg>
		</div>

		<section class="card" aria-labelledby="success-title">
			<div class="success-icon" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
					<path d="M5 12.5 9.25 17 19 7" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</div>

			<h1 id="success-title">Authentication complete</h1>
			<p class="lead">Your OpenAI account is connected securely and ready to use with OpenCode.</p>

			<div class="status" role="status">
				<span class="status-dot" aria-hidden="true"></span>
				<span>Credentials encrypted and stored</span>
			</div>

			<p class="next-step"><strong>You can close this tab.</strong> Return to your terminal to continue.</p>
		</section>
	</main>
</body>
</html>`;
}

// Retained for the standalone HTML artifact generated by the package build.
export const oauthSuccessHtml = renderOAuthSuccessHtml("");
