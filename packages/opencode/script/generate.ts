import path from "path"
import { loadModelsDevData } from "@opencode-ai/script/models-dev"

process.chdir(path.resolve(import.meta.dir, ".."))

export const modelsData = await loadModelsDevData()
