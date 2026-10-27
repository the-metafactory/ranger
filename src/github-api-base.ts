import { z } from "zod";

export const GitHubApiBaseUrlSchema = z.string().url().refine(value => {
 if (!URL.canParse(value)) return false;
 const url = new URL(value);
 return url.protocol === "https:" && url.username === "" && url.password === "" && !value.includes("?") && !value.includes("#");
}, "an HTTPS API base URL without credentials, query or fragment")
 .transform(value => value.replace(/\/+$/, ""))
 .default("https://api.github.com");
