# Keep kotlinx.serialization and OkHttp happy when minification is enabled later.
# (Minification is OFF in Phase 1; rules kept here for when we turn it on.)
-dontwarn okhttp3.**
-dontwarn okio.**
