const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const runtimeErrors = [];
  page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));

  const navigate = async (resource) => {
    const scrim = page.locator(".sheet-scrim");
    if (await scrim.count()) await scrim.click({ position: { x: 4, y: 4 } });
    await page.locator(`.resource-nav nav button[aria-label="${resource}"]`).click();
    await page.locator(".page-head h1").getByText(resource, { exact: true }).waitFor();
  };
  const openRow = async (name) => {
    const row = page.locator(".resource-table tbody tr").filter({ hasText: name }).first();
    await row.waitFor();
    await row.locator("td:not(.selection-col)").first().click();
    await page.locator(".sheet-right").waitFor();
    await page.locator(".sheet-title-stack h2").filter({ hasText: name }).waitFor();
    await page.locator(".detail-relations-loading").waitFor({ state: "hidden" }).catch(() => {});
  };
  const groupCount = async (id) => {
    const group = page.locator(`[data-relation-id="${id}"]`);
    if (!await group.count()) return -1;
    return group.locator(".detail-relation-list > button").count();
  };

  await page.goto("http://localhost:1420", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('[data-cluster-id="prod-eu"]').dblclick();
  await page.locator(".resource-nav").waitFor();

  await navigate("Deployments");
  await openRow("checkout-api");
  const deployment = {
    rollout: await page.locator('[data-detail-section="rollout"]').isVisible(),
    strategy: await page.locator('[data-detail-section="strategy"]').isVisible(),
    template: await page.locator('[data-detail-section="template"]').isVisible(),
    replicaSets: await groupCount("replicasets"),
    managedPods: await groupCount("pods"),
  };

  const firstManagedPod = page.locator('[data-relation-id="pods"] .detail-relation-list > button').first();
  const managedPodName = (await firstManagedPod.locator("strong").textContent()).trim();
  await firstManagedPod.click();
  await page.locator(".sheet-title-stack h2").getByText(managedPodName, { exact: true }).waitFor();
  await page.locator(".detail-relations-loading").waitFor({ state: "hidden" }).catch(() => {});
  const pod = {
    runtime: await page.locator('[data-detail-section="runtime"]').isVisible(),
    containers: await page.locator('[data-detail-section="containers"]').isVisible(),
    directOwners: await groupCount("owners"),
    controllerAncestry: await groupCount("controller-ancestry"),
    services: await groupCount("services"),
    actions: await page.locator(".detail-header-actions").evaluate((element) => {
      const labels = [...element.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
      return labels.includes("Evict") && !labels.includes("Scale") && !labels.includes("Restart");
    }),
  };

  await navigate("Pods");
  const podRow = page.locator(".resource-table tbody tr").filter({ hasText: managedPodName }).first();
  await podRow.click({ button: "right" });
  pod.contextActions = await page.locator(".app-context-menu").evaluate((element) => {
    const labels = [...element.querySelectorAll('[role="menuitem"]')].map((button) => button.textContent.trim());
    return labels.includes("Evict") && !labels.includes("Scale") && !labels.includes("Restart rollout");
  });
  await page.keyboard.press("Escape");

  await navigate("Nodes");
  await openRow("node-01");
  const node = {
    capacity: await page.locator('[data-detail-section="capacity"]').isVisible(),
    scheduledPods: await groupCount("pods"),
    lease: await groupCount("lease"),
  };

  await navigate("ReplicaSets");
  await openRow("checkout-api");
  const replicaSet = {
    replicas: await page.locator('[data-detail-section="replicas"]').isVisible(),
    owner: await groupCount("owners"),
    managedPods: await groupCount("pods"),
  };

  await navigate("CronJobs");
  await openRow("order-reconciler");
  const cronJob = {
    schedule: await page.locator('[data-detail-section="schedule"]').isVisible(),
    jobs: await groupCount("jobs"),
    managedPods: await groupCount("pods"),
  };

  await navigate("Services");
  await openRow("checkout-api");
  const service = {
    networking: await page.locator('[data-detail-section="network"]').isVisible(),
    routing: await page.locator('[data-detail-section="routing"]').isVisible(),
    selectedPods: await groupCount("pods"),
    endpoints: await groupCount("endpoints"),
    ingresses: await groupCount("ingresses"),
  };

  await navigate("Endpoints");
  await openRow("checkout-api");
  const endpoints = {
    endpointDetails: await page.locator('[data-detail-section="endpoints"]').isVisible(),
    service: await groupCount("service"),
    targetPods: await groupCount("pods"),
  };

  await navigate("Ingresses");
  await openRow("checkout-api");
  const ingress = {
    routing: await page.locator('[data-detail-section="routing"]').isVisible(),
    ingressClass: await groupCount("class"),
    backendServices: await groupCount("services"),
  };

  await navigate("Events");
  await openRow("ScalingReplicaSet");
  const event = {
    details: await page.locator('[data-detail-section="event"]').isVisible(),
    regardingText: await page.locator('[data-detail-section="event"]').getByText("Deployment/checkout-api", { exact: true }).isVisible(),
    regardingResource: await groupCount("regarding"),
  };

  await navigate("Config Maps");
  await openRow("checkout-api-config");
  const configMap = {
    data: await page.locator('[data-detail-section="data"]').isVisible(),
    referencingPods: await groupCount("pods"),
  };

  await navigate("Secrets");
  await openRow("checkout-api-tls");
  const secret = {
    masked: await page.locator('[data-detail-section="data"]').getByText("Masked in the native Rust boundary", { exact: true }).isVisible(),
    referencingPods: await groupCount("pods"),
    tlsIngresses: await groupCount("ingresses"),
  };

  await navigate("Roles");
  await openRow("config-reader");
  const role = {
    permissions: await page.locator('[data-detail-section="permissions"]').isVisible(),
    bindings: await groupCount("bindings"),
  };

  await navigate("Role Bindings");
  await openRow("checkout-config-reader");
  const roleBinding = {
    binding: await page.locator('[data-detail-section="binding"]').isVisible(),
    grantedRole: await groupCount("role"),
    serviceAccounts: await groupCount("subjects"),
  };

  await navigate("Service Accounts");
  await openRow("checkout-api");
  const serviceAccount = {
    identity: await page.locator('[data-detail-section="identity"]').isVisible(),
    pods: await groupCount("pods"),
    bindings: await groupCount("bindings"),
  };

  await navigate("Pod Disruption Budgets");
  await openRow("checkout-api");
  const disruptionBudget = {
    availability: await page.locator('[data-detail-section="availability"]').isVisible(),
    protectedPods: await groupCount("pods"),
    controllers: await groupCount("controllers"),
  };

  await navigate("Port Forwarding");
  await openRow("Service/checkout-api");
  const portForward = {
    forward: await page.locator('[data-detail-section="forward"]').isVisible(),
    target: await groupCount("target"),
  };

  await navigate("Persistent Volume Claims");
  await openRow("orders-db-1");
  const pvc = {
    claim: await page.locator('[data-detail-section="claim"]').isVisible(),
    volume: await groupCount("volume"),
    storageClass: await groupCount("storageclass"),
    mountedPods: await groupCount("pods"),
  };

  await navigate("Persistent Volumes");
  await openRow("pv-orders-db-0");
  const persistentVolume = {
    volume: await page.locator('[data-detail-section="volume"]').isVisible(),
    claim: await groupCount("claim"),
    storageClass: await groupCount("storageclass"),
  };

  await navigate("Horizontal Pod Autoscalers");
  await openRow("checkout-api");
  const hpa = {
    autoscaling: await page.locator('[data-detail-section="autoscaling"]').isVisible(),
    target: await groupCount("target"),
  };

  await navigate("Custom Resource Definitions");
  await openRow("certificates.cert-manager.io");
  const crd = {
    definition: await page.locator('[data-detail-section="definition"]').isVisible(),
    versions: await page.locator('[data-detail-section="definition"] .detail-field').filter({ hasText: "Versions" }).isVisible(),
    instances: await groupCount("instances"),
  };
  const firstCustomResource = page.locator('[data-relation-id="instances"] .detail-relation-list > button').first();
  const customResourceName = (await firstCustomResource.locator("strong").textContent()).trim();
  await firstCustomResource.click();
  await page.locator(".sheet-title-stack h2").getByText(customResourceName, { exact: true }).waitFor();
  const customResource = {
    fallbackSummary: await page.locator('[data-detail-section="summary"]').isVisible(),
    kind: await page.locator(".detail-metadata dl").getByText("Certificate", { exact: true }).isVisible(),
  };
  await navigate("Custom Resource Definitions");
  await page.getByRole("button", { name: "Open Certificate instances", exact: true }).click();
  await page.locator(".page-head h1").getByText("Certificate", { exact: true }).waitFor();
  crd.instancesPage = true;

  const resourcePages = await page.locator(".resource-nav nav button[aria-label]").evaluateAll((buttons) => [...new Set(buttons.map((button) => button.getAttribute("aria-label")).filter(Boolean))].filter((label) => label !== "Overview"));
  const kindSweepFailures = [];
  for (const resourcePage of resourcePages) {
    await navigate(resourcePage);
    const firstRow = page.locator(".resource-table tbody tr").first();
    if (!await firstRow.count() || await firstRow.locator("td").count() === 0) {
      kindSweepFailures.push(`${resourcePage}: no demo instance`);
      continue;
    }
    await firstRow.locator("td:not(.selection-col)").first().click();
    await page.locator(".sheet-right").waitFor();
    if (await page.locator("[data-detail-section]").count() === 0) kindSweepFailures.push(`${resourcePage}: no kind-specific section`);
  }
  const kindSweep = { total: resourcePages.length, failures: kindSweepFailures };

  const result = { deployment, pod, node, replicaSet, cronJob, service, endpoints, ingress, event, configMap, secret, role, roleBinding, serviceAccount, disruptionBudget, portForward, pvc, persistentVolume, hpa, crd, customResource, kindSweep, runtimeErrors };
  console.log(JSON.stringify(result, null, 2));

  const valid = deployment.rollout && deployment.strategy && deployment.template && deployment.replicaSets >= 1 && deployment.managedPods >= 1
    && pod.runtime && pod.containers && pod.directOwners >= 1 && pod.controllerAncestry >= 1 && pod.services >= 1 && pod.actions && pod.contextActions
    && node.capacity && node.scheduledPods >= 1 && node.lease >= 0
    && replicaSet.replicas && replicaSet.owner >= 1 && replicaSet.managedPods >= 1
    && cronJob.schedule && cronJob.jobs >= 1 && cronJob.managedPods >= 1
    && service.networking && service.routing && service.selectedPods >= 1 && service.endpoints >= 1 && service.ingresses >= 1
    && endpoints.endpointDetails && endpoints.service >= 1 && endpoints.targetPods >= 1
    && ingress.routing && ingress.ingressClass >= 1 && ingress.backendServices >= 1
    && event.details && event.regardingText && event.regardingResource >= 1
    && configMap.data && configMap.referencingPods >= 1
    && secret.masked && secret.referencingPods >= 1 && secret.tlsIngresses >= 1
    && role.permissions && role.bindings >= 1
    && roleBinding.binding && roleBinding.grantedRole >= 1 && roleBinding.serviceAccounts >= 1
    && serviceAccount.identity && serviceAccount.pods >= 1 && serviceAccount.bindings >= 1
    && disruptionBudget.availability && disruptionBudget.protectedPods >= 1 && disruptionBudget.controllers >= 1
    && portForward.forward && portForward.target >= 1
    && pvc.claim && pvc.volume >= 1 && pvc.storageClass >= 1 && pvc.mountedPods >= 0
    && persistentVolume.volume && persistentVolume.claim >= 1 && persistentVolume.storageClass >= 1
    && hpa.autoscaling && hpa.target >= 1
    && crd.definition && crd.versions && crd.instances >= 1 && crd.instancesPage
    && customResource.fallbackSummary && customResource.kind
    && kindSweep.total >= 40 && kindSweep.failures.length === 0
    && runtimeErrors.length === 0;
  await browser.close();
  if (!valid) process.exit(1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
