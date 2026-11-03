/**
 * Barre d'état Albert API pour Pi (remplace le footer), en appel direct à Albert :
 *   [modèle • réflexion] │ dossier (branche)
 *   Contexte ███░░ │ RPM ███░░ x/50 │ TPM ███░░ x/246k
 *   Session x tok · ≈ x gCO2e │ Jour x req · x gCO2e
 *
 * Réglages (variables d'environnement, toutes optionnelles) :
 *   ALBERT_KEY_ID   id de clé pour filtrer « Jour »   (défaut : tout le compte)
 *   ALBERT_RPM      plafond requêtes/minute affiché   (défaut 50)
 *   ALBERT_TPM      plafond jetons/minute affiché     (défaut 246000)
 * L'URL et la clé viennent du provider Pi du modèle courant (models.json), rien à configurer.
 * Les défauts RPM/TPM sont ceux de la grille publique (Expérimentation / Production limitée) :
 * https://ia.numerique.gouv.fr/outils-ia/albert-api/tarifs-et-limites/
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";

const env = process.env;
const CLE_ID = env.ALBERT_KEY_ID;
const LIMITES = { rpm: Number(env.ALBERT_RPM) || 50, tpm: Number(env.ALBERT_TPM) || 246_000 };
const LARGEUR = 10;

async function get(base: string, apiKey: string | undefined, path: string): Promise<any> {
	const r = await fetch(base.replace(/\/$/, "") + path, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
		signal: AbortSignal.timeout(3000),
	});
	if (!r.ok) throw new Error(String(r.status));
	return r.json();
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const g = (kg: number) => (kg * 1000 >= 10 ? (kg * 1000).toFixed(0) : (kg * 1000).toFixed(1));
// Estimation 4 caractères par jeton : l'usage renvoyé par Albert à Pi n'est pas exploitable (content en tableau, prompt_tokens=0).
const jetons = (x: unknown) => Math.round(JSON.stringify(x ?? "").length / 4);

export default function (pi: ExtensionAPI) {
	let envois: { t: number; jetons: number }[] = [];
	let sessionEntree = 0;
	let dernierEnvoi = 0;
	let jour: { req: number; kg: number; tok: number } | undefined;
	let albertKo = false;
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
			if (!ctx.model) return;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok) throw new Error(auth.error);
			const base = auth.baseUrl ?? ctx.model.baseUrl;
			const end = Math.floor(Date.now() / 1000);
			const filtre = CLE_ID ? `&key_id=${encodeURIComponent(CLE_ID)}` : "";
			const u = (await get(base, auth.apiKey, `/me/usage?start_time=${end - (end % 86400)}&end_time=${end}${filtre}`)).data?.[0];
			jour = { req: u?.requests ?? 0, kg: u?.impacts?.kgCO2eq ?? 0, tok: u?.completion_tokens ?? 0 };
			albertKo = false;
		} catch {
			albertKo = true;
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
					const l1 = t.fg("accent", `[${m?.id ?? "aucun modèle"}${m?.reasoning ? ` • ${pi.getThinkingLevel()}` : ""}]`) + sep +
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
						albertKo ? t.fg("error", "usage Albert indisponible")
							: jour ? t.fg("dim", "Jour ") + `${jour.req} req · ${g(jour.kg)} gCO2e` : "",
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
