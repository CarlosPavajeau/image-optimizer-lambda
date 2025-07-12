import { processExistingImages } from "./process-existing-images";

// Quick processing with safe defaults
processExistingImages({
  skipExisting: true,
  useLambda: false,
  batchSize: 5,
  delayBetweenBatches: 500,
});
