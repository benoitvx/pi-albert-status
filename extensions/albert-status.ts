/**
 * Barre d'état Albert API pour Pi (remplace le footer), via llm-proxy :
 *   [modèle • réflexion] │ dossier (branche)
 *   Contexte ███░░ │ RPM ███░░ x/50 │ TPM ███░░ x/246k
 *   Session x tok · ≈ x gCO2e │ Jour x req · x gCO2e │ ⏳ attente de quota
 *
 * Réglages (variables d'environnement, toutes optionnelles) :
 *   LLM_PROXY_URL   adresse du proxy                  (défaut http://127.0.0.1:8080)
 *   ALBERT_KEY_ID   id de clé pour filtrer « Jour »   (défaut : tout le compte)
 *   ALBERT_RPM      plafond requêtes/minute affiché   (défaut 50)
 *   ALBERT_TPM      plafond jetons/minute affiché     (défaut 246000)
 * Les défauts RPM/TPM sont ceux de la grille publique (Expérimentation / Production limitée) :
 * https://ia.numerique.gouv.fr/outils-ia/albert-api/tarifs-et-limites/
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";

const env = process.env;
const PROXY = (env.LLM_PROXY_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const CLE_ID = env.ALBERT_KEY_ID;
const LIMITES = { rpm: Number(env.ALBERT_RPM) || 50, tpm: Number(env.ALBERT_TPM) || 246_000 };
const LARGEUR = 10;

async function get(path: string): Promise<any> {
	const r = await fetch(PROXY + path, { signal: AbortSignal.timeout(3000) });
	if (!r.ok) throw new Error(String(r.status));
	return r.json();
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const g = (kg: number) => (kg * 1000 >= 10 ? (kg * 1000).toFixed(0) : (kg * 1000).toFixed(1));
// Estimation 4 caractères par jeton : l'usage renvoyé par Albert via le proxy n'est pas fiable pour Pi.
const jetons = (x: unknown) => Math.round(JSON.stringify(x ?? "").length / 4);

export default function (pi: ExtensionAPI) {
	let envois: { t: number; jetons: number }[] = [];
	let sessionEntree = 0;
	let dernierEnvoi = 0;
	let jour: { req: number; kg: number; tok: number } | undefined;
	let attente = "";
	let proxyKo = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let render = () => {};

	pi.on("before_provider_request", async (e) => {
		const n = jetons(e.payload);
		envois.push({ t: Date.now(), jetons: n });
		sessionEntree += n;
		dernierEnvoi = n;
		render();
	});

	function sessionSortie(ctx: any) {
		let n = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") n += e.message.usage?.output || jetons(e.message.content);
		}
		return n;
	}

	async function poll(ctx: any) {
		try {
			const end = Math.floor(Date.now() / 1000);
			const filtre = CLE_ID ? `&key_id=${encodeURIComponent(CLE_ID)}` : "";
			const u = (await get(`/v1/me/usage?start_time=${end - (end % 86400)}&end_time=${end}${filtre}`)).data?.[0];
			jour = { req: u?.requests ?? 0, kg: u?.impacts?.kgCO2eq ?? 0, tok: u?.completion_tokens ?? 0 };
			attente = "";
			if (ctx.model?.baseUrl?.startsWith(PROXY)) {
				const w = await get(`/proxy/attente?model=${encodeURIComponent(ctx.model.id)}`);
				if (w.en_cours > 0) attente = `⏳ ${w.en_cours} en attente ~${Math.ceil(w.prevision_secs)}s`;
			}
			proxyKo = false;
		} catch {
			proxyKo = true;
		}
		render();
	}

	pi.on("session_start", async (_e, ctx) => {
		ctx.ui.setFooter((tui, t, footerData) => {
			render = () => tui.requestRender();
			const unsub = footerData.onBranchChange(render);
			const sep = t.fg("dim", " │ ");
			const barre = (label: string, val: number, max: number, couleur: string, texte: string) => {
				const pct = Math.max(0, Math.min(1, val / max));
				const c = pct >= 0.9 ? "error" : pct >= 0.7 ? "warning" : couleur;
				const plein = Math.round(pct * LARGEUR);
				return t.fg("dim", `${label} `) + t.fg(c as any, "█".repeat(plein)) +
					t.fg("borderMuted", "█".repeat(LARGEUR - plein)) + " " + t.fg(c as any, texte);
			};
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					envois = envois.filter((x) => Date.now() - x.t < 60_000);
					const m = ctx.model;
					const branche = footerData.getGitBranch();
					const l1 = t.fg("accent", `[${m?.id ?? "aucun modèle"} • ${pi.getThinkingLevel()}]`) + sep +
						t.fg("warning", basename(ctx.cwd)) + (branche ? t.fg("dim", ` (${branche})`) : "");

					const fenetre = m?.contextWindow ?? 0;
					const rpm = envois.length;
					const tpm = envois.reduce((s, x) => s + x.jetons, 0);
					const l2 = [
						fenetre ? barre("Contexte", dernierEnvoi, fenetre, "success", `${Math.round((dernierEnvoi / fenetre) * 100)}%`) : "",
						barre("RPM", rpm, LIMITES.rpm, "accent", `${rpm}/${LIMITES.rpm}`),
						barre("TPM", tpm, LIMITES.tpm, "accent", `${k(tpm)}/${k(LIMITES.tpm)}`),
					].filter(Boolean).join(sep);

					const sortie = sessionSortie(ctx);
					const total = sessionEntree + sortie;
					// CO2 de session estimé : intensité du jour (kg par jeton de sortie) × jetons de sortie de la session.
					const co2 = jour?.tok ? ` · ≈ ${g((jour.kg / jour.tok) * sortie)} gCO2e` : "";
					const l3 = [
						t.fg("dim", "Session ") + `${k(total)} tok${co2}`,
						proxyKo ? t.fg("error", "llm-proxy injoignable")
							: jour ? t.fg("dim", "Jour ") + `${jour.req} req · ${g(jour.kg)} gCO2e` : "",
						attente && t.fg("warning", attente),
					].filter(Boolean).join(sep);

					return [l1, l2, l3].map((l) => truncateToWidth(l, width));
				},
			};
		});
		await poll(ctx);
		clearInterval(timer);
		timer = setInterval(() => poll(ctx), 10_000);
	});
	pi.on("model_select", async (_e, ctx) => poll(ctx));
	pi.on("turn_end", async (_e, ctx) => poll(ctx));
	pi.on("session_shutdown", async () => clearInterval(timer));
}
