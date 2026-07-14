<script setup lang="ts">
import HeroSection from './sections/HeroSection.vue';
import CapabilityMarquee from './sections/CapabilityMarquee.vue';
import ProductShowcase from './sections/ProductShowcase.vue';
import FeatureDeepDive from './sections/FeatureDeepDive.vue';
import FeatureBento from './sections/FeatureBento.vue';
import ProviderStrip from './sections/ProviderStrip.vue';
import CtaBanner from './sections/CtaBanner.vue';
</script>

<template>
  <div class="aq-home">
    <HeroSection />
    <CapabilityMarquee />
    <ProductShowcase />
    <FeatureDeepDive />
    <FeatureBento />
    <ProviderStrip />
    <CtaBanner />
  </div>
</template>

<style scoped>
.aq-home {
  width: 100%;
  overflow-x: hidden;
}
</style>
